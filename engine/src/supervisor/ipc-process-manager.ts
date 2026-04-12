/**
 * IpcProcessManager — IPC proxy for ProcessManager.
 *
 * Implements the same EventEmitter + method interface as the real ProcessManager,
 * but forwards all commands to the ProcessManager Worker via IPC and receives
 * events back. Maintains a local state mirror for sync query methods.
 *
 * Used by EngineServer when running in Supervisor mode.
 */
import { EventEmitter } from "node:events";
import type { ProcessManagerLike, SendResult } from "../process-manager.js";
import type { IpcCommand, IpcEvent } from "./ipc-types.js";

/**
 * Minimal IPC channel interface — works with both ChildProcess and process itself.
 * In Supervisor mode (direct fork), this is the ChildProcess.
 * In WS child mode, this wraps process.send/process.on.
 */
export interface IpcChannel {
  send(msg: unknown): void;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  on(event: string, listener: (...args: any[]) => void): void;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  removeAllListeners(event?: string): void;
}

export class IpcProcessManager extends EventEmitter implements ProcessManagerLike {
  /** Local mirror of running processes for sync query methods. */
  private runningProcesses = new Map<string, number | undefined>();

  private channel: IpcChannel;

  constructor(channel: IpcChannel) {
    super();
    this.channel = channel;
    this.setupListeners();
  }

  /**
   * Handle an incoming IPC event from the PM worker.
   * Can be called externally (e.g., from ws-server-child process.on("message")).
   */
  handleEvent(event: IpcEvent): void {
    this.handleWorkerEvent(event);
  }

  // ── Spawn methods ──

  sortie(
    id: string,
    worktreePath: string,
    issueNumber: number,
    extraPrompt?: string,
    skill?: string,
    extraEnv?: Record<string, string>,
  ): void {
    this.sendCommand({
      type: "sortie",
      id,
      worktreePath,
      issueNumber,
      extraPrompt,
      skill,
      extraEnv,
    });
  }

  dispatchSortie(
    id: string,
    cwd: string,
    prompt: string,
    type: "investigate" | "modify",
    extraEnv?: Record<string, string>,
  ): void {
    this.sendCommand({
      type: "dispatch-sortie",
      id,
      cwd,
      prompt,
      dispatchType: type,
      extraEnv,
    });
  }

  launchCommander(
    id: string,
    fleetPath: string,
    additionalDirs: string[],
    systemPrompt?: string,
    extraEnv?: Record<string, string>,
  ): void {
    this.sendCommand({
      type: "launch-commander",
      id,
      fleetPath,
      additionalDirs,
      systemPrompt,
      extraEnv,
    });
  }

  resumeCommander(
    id: string,
    sessionId: string,
    fleetPath: string,
    additionalDirs: string[],
    systemPrompt?: string,
    extraEnv?: Record<string, string>,
  ): void {
    this.sendCommand({
      type: "resume-commander",
      id,
      sessionId,
      fleetPath,
      additionalDirs,
      systemPrompt,
      extraEnv,
    });
  }

  resumeSession(
    id: string,
    sessionId: string,
    message: string,
    cwd: string,
    extraEnv?: Record<string, string>,
    appendSystemPrompt?: string,
    logFileName?: string,
  ): void {
    this.sendCommand({
      type: "resume-session",
      id,
      sessionId,
      message,
      cwd,
      extraEnv,
      appendSystemPrompt,
      logFileName,
    });
  }

  // ── Communication methods ──

  sendMessage(
    id: string,
    message: string,
    images?: Array<{ base64: string; mediaType: string }>,
  ): SendResult {
    this.sendCommand({ type: "send-message", id, message, images });
    return { ok: true };
  }

  sendToolResult(id: string, toolUseId: string, result: string): SendResult {
    this.sendCommand({ type: "send-tool-result", id, toolUseId, result });
    return { ok: true };
  }

  // ── Lifecycle methods ──

  kill(id: string): boolean {
    // Optimistic: assume success and update mirror.
    // The actual kill result is sent back as kill-result event.
    const wasRunning = this.runningProcesses.has(id);
    if (wasRunning) {
      this.runningProcesses.delete(id);
    }
    this.sendCommand({ type: "kill", id });
    return wasRunning;
  }

  killAll(): void {
    this.runningProcesses.clear();
    this.sendCommand({ type: "kill-all" });
  }

  // ── Query methods (sync, using local mirror) ──

  isRunning(id: string): boolean {
    return this.runningProcesses.has(id);
  }

  getActiveCount(): number {
    return this.runningProcesses.size;
  }

  getPid(id: string): number | undefined {
    return this.runningProcesses.get(id);
  }

  // ── IPC internals ──

  private setupListeners(): void {
    this.channel.on("message", (msg: IpcEvent) => {
      this.handleWorkerEvent(msg);
    });
  }

  private handleWorkerEvent(event: IpcEvent): void {
    switch (event.type) {
      case "spawn":
        this.runningProcesses.set(event.id, event.pid);
        this.emit("spawn", event.id);
        break;

      case "data":
        this.emit("data", event.id, event.message);
        break;

      case "exit":
        this.runningProcesses.delete(event.id);
        this.emit("exit", event.id, event.code);
        break;

      case "error":
        this.emit("error", event.id, new Error(event.errorMessage));
        break;

      case "rate-limit":
        this.emit("rate-limit", event.id);
        break;

      case "state-dump":
        // Rebuild mirror from worker's state (used after WS child restart)
        this.runningProcesses.clear();
        for (const proc of event.processes) {
          this.runningProcesses.set(proc.id, proc.pid);
        }
        console.log(`[ipc-pm] State dump received: ${event.processes.length} running processes`);
        break;

      case "kill-result":
      case "send-result":
      case "pong":
        // Acknowledgements — no action needed
        break;
    }
  }

  private sendCommand(command: IpcCommand): void {
    try {
      this.channel.send(command);
    } catch (err) {
      console.error("[ipc-pm] Failed to send command to worker:", err);
    }
  }
}
