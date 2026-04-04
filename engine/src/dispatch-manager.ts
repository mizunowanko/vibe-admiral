import { randomUUID } from "node:crypto";
import type { ProcessManagerLike } from "./process-manager.js";
import type { DispatchProcess, DispatchType, CommanderRole, Dispatch } from "./types.js";

export interface DispatchRequest {
  fleetId: string;
  parentRole: CommanderRole;
  prompt: string;
  name: string;
  type: DispatchType;
  cwd: string;
}

/**
 * Manages Dispatch processes — independent CLI sessions spawned by Engine
 * on behalf of Commanders (Dock/Flagship).
 *
 * Unlike Ship/Escort, Dispatches have no XState machine, no worktree,
 * and no DB persistence. They are transient in-memory processes.
 */
export class DispatchManager {
  private dispatches = new Map<string, DispatchProcess>();
  private processManager: ProcessManagerLike;

  /** Callback invoked when a Dispatch completes, to notify the parent Commander. */
  private onCompleteHandler: ((dispatch: DispatchProcess) => void) | null = null;
  /** Callback invoked when a Dispatch is created, to notify the frontend. */
  private onCreateHandler: ((dispatch: DispatchProcess) => void) | null = null;

  constructor(processManager: ProcessManagerLike) {
    this.processManager = processManager;
  }

  setOnCompleteHandler(handler: (dispatch: DispatchProcess) => void): void {
    this.onCompleteHandler = handler;
  }

  setOnCreateHandler(handler: (dispatch: DispatchProcess) => void): void {
    this.onCreateHandler = handler;
  }

  /**
   * Create and launch a new Dispatch process.
   */
  launch(req: DispatchRequest): DispatchProcess {
    const id = `dispatch-${randomUUID()}`;

    const dispatch: DispatchProcess = {
      id,
      fleetId: req.fleetId,
      parentRole: req.parentRole,
      name: req.name,
      prompt: req.prompt,
      type: req.type,
      status: "running",
      cwd: req.cwd,
      startedAt: Date.now(),
    };

    this.dispatches.set(id, dispatch);

    this.processManager.dispatchSortie(
      id,
      req.cwd,
      req.prompt,
      req.type,
    );

    this.onCreateHandler?.(dispatch);

    return dispatch;
  }

  /**
   * Handle Dispatch process exit. Update status and notify parent Commander.
   */
  onProcessExit(id: string, code: number | null, resultText?: string): void {
    const dispatch = this.dispatches.get(id);
    if (!dispatch) return;

    dispatch.completedAt = Date.now();
    if (code === 0) {
      dispatch.status = "completed";
    } else {
      dispatch.status = "failed";
    }
    if (resultText !== undefined) {
      dispatch.result = resultText;
    }

    this.onCompleteHandler?.(dispatch);
  }

  /**
   * Accumulate the final result text from a "result" type message.
   */
  setResult(id: string, result: string): void {
    const dispatch = this.dispatches.get(id);
    if (dispatch) {
      dispatch.result = result;
    }
  }

  isDispatchProcess(id: string): boolean {
    return id.startsWith("dispatch-");
  }

  getDispatch(id: string): DispatchProcess | undefined {
    return this.dispatches.get(id);
  }

  getDispatchesByFleet(fleetId: string): DispatchProcess[] {
    const results: DispatchProcess[] = [];
    for (const d of this.dispatches.values()) {
      if (d.fleetId === fleetId) {
        results.push(d);
      }
    }
    return results;
  }

  /** Convert a DispatchProcess to the lightweight Dispatch type for frontend. */
  toDispatch(dp: DispatchProcess): Dispatch {
    return {
      id: dp.id,
      parentRole: dp.parentRole,
      fleetId: dp.fleetId,
      name: dp.name,
      status: dp.status,
      startedAt: dp.startedAt,
      completedAt: dp.completedAt,
      result: dp.result,
    };
  }

  kill(id: string): boolean {
    const dispatch = this.dispatches.get(id);
    if (!dispatch || dispatch.status !== "running") return false;
    dispatch.status = "failed";
    dispatch.completedAt = Date.now();
    return this.processManager.kill(id);
  }

  killAll(): void {
    for (const [id, dispatch] of this.dispatches) {
      if (dispatch.status === "running") {
        dispatch.status = "failed";
        dispatch.completedAt = Date.now();
        this.processManager.kill(id);
      }
    }
  }
}
