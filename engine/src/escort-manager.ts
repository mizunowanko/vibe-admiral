import { randomUUID } from "node:crypto";
import type { ProcessManager } from "./process-manager.js";
import type { ShipManager } from "./ship-manager.js";
import type { FleetDatabase } from "./db.js";
import type { ShipActorManager } from "./ship-actor-manager.js";
import type { EscortProcess, GatePhase, GateType, Phase } from "./types.js";
import { isGatePhase, GATE_PREV_PHASE } from "./types.js";

/**
 * On-demand Escort coordination layer using session resume.
 *
 * Escorts are now fully separated from Ships — they have their own
 * `escorts` DB table and do not use ShipManager for persistence.
 * EscortManager owns the full Escort lifecycle: creation, launch,
 * session resume, cleanup, and process exit handling.
 *
 * Lifecycle per gate:
 *   1. Ship enters gate phase (e.g., plan-gate)
 *   2. Engine calls launchEscort(parentShipId, gatePhase, gateType)
 *   3. EscortManager creates or resumes an Escort process
 *   4. Escort reviews, submits verdict, and exits
 *   5. onEscortExit() handles cleanup or phase revert (if no verdict)
 */
export class EscortManager {
  private processManager: ProcessManager;
  private shipManager: ShipManager;
  private getDatabase: () => FleetDatabase | null;
  private actorManager: ShipActorManager | null = null;
  /** parentShipId → escortId mapping (one Escort per parent Ship). */
  private escorts = new Map<string, string>();
  private onEscortDeathCallback: ((shipId: string, message: string) => void) | null = null;

  constructor(processManager: ProcessManager, shipManager: ShipManager, getDatabase: () => FleetDatabase | null) {
    this.processManager = processManager;
    this.shipManager = shipManager;
    this.getDatabase = getDatabase;
  }

  setActorManager(actorManager: ShipActorManager): void {
    this.actorManager = actorManager;
  }

  /** Set callback for Escort death notifications (sent to Flagship). */
  setEscortDeathHandler(handler: (shipId: string, message: string) => void): void {
    this.onEscortDeathCallback = handler;
  }

  /**
   * Launch an Escort on-demand for a specific gate phase.
   *
   * - First gate (no existing Escort): creates a new Escort record and launches fresh
   * - Subsequent gates (existing Escort with sessionId): resumes the previous session
   * - If an Escort process is already running, returns null (duplicate prevention)
   *
   * Returns the escort ID if launched, null if skipped or failed.
   */
  launchEscort(
    parentShipId: string,
    gatePhase?: GatePhase,
    _gateType?: GateType,
    extraPrompt?: string,
    gatePrompt?: string,
  ): string | null {
    // Prevent duplicate Escorts for the same parent Ship
    const existingEscortId = this.escorts.get(parentShipId);
    if (existingEscortId && this.processManager.isRunning(existingEscortId)) {
      console.log(
        `[escort-manager] Escort already running for Ship ${parentShipId.slice(0, 8)}... (${existingEscortId.slice(0, 8)}...)`,
      );
      return null;
    }

    const parentShip = this.shipManager.getShip(parentShipId);
    if (!parentShip) {
      console.warn(`[escort-manager] Parent Ship ${parentShipId} not found — cannot launch Escort`);
      return null;
    }

    const db = this.getDatabase();

    try {
      // Check for an existing Escort record (from a previous gate) with a sessionId
      const existingEscort = db?.getEscortByShipId(parentShipId);

      if (existingEscort?.sessionId) {
        // Resume previous Escort session — preserves context from prior gate reviews
        const escortId = this.resumeEscort(existingEscort, parentShip, gatePhase ?? "plan-gate", gatePrompt);
        this.escorts.set(parentShipId, escortId);

        console.log(
          `[escort-manager] Resumed Escort ${escortId.slice(0, 8)}... (session: ${existingEscort.sessionId.slice(0, 12)}...) for Ship ${parentShipId.slice(0, 8)}... at ${gatePhase ?? "unknown"} gate`,
        );

        return escortId;
      }

      // First gate or no sessionId — launch a fresh Escort
      const escortId = this.sortieEscort(parentShip, gatePhase, extraPrompt, gatePrompt);
      this.escorts.set(parentShipId, escortId);

      console.log(
        `[escort-manager] Launched new Escort ${escortId.slice(0, 8)}... for Ship ${parentShipId.slice(0, 8)}... at ${gatePhase ?? "unknown"} gate (issue #${parentShip.issueNumber})`,
      );

      return escortId;
    } catch (err) {
      console.error(`[escort-manager] Failed to launch Escort for Ship ${parentShipId.slice(0, 8)}...:`, err);
      return null;
    }
  }

  /**
   * Notify Flagship that an Escort launch failed.
   * Called by api-server when launchEscort() returns null and phase is reverted.
   * Distinct from onEscortExit() death notifications — this covers failures
   * before a process is ever created (e.g., sortie/resume errors, duplicate prevention).
   */
  notifyLaunchFailure(parentShipId: string, gatePhase: GatePhase, reason: string): void {
    const parentShip = this.shipManager.getShip(parentShipId);
    if (!parentShip) return;

    const prevPhase = GATE_PREV_PHASE[gatePhase];
    const message = `Escort launch failed for Ship #${parentShip.issueNumber} (${parentShip.issueTitle}) at ${gatePhase}: ${reason}. Phase reverted to ${prevPhase}.`;
    this.onEscortDeathCallback?.(parentShipId, message);
  }

  /**
   * Launch a fresh Escort for the first gate.
   * Creates a new Escort record in the escorts table and spawns the process.
   */
  private sortieEscort(
    parentShip: { id: string; repo: string; issueNumber: number; worktreePath: string },
    gatePhase?: GatePhase,
    extraPrompt?: string,
    gatePrompt?: string,
  ): string {
    const escortId = randomUUID();
    const db = this.getDatabase();

    const escort: EscortProcess = {
      id: escortId,
      shipId: parentShip.id,
      sessionId: null,
      processPid: null,
      phase: "plan",
      createdAt: new Date().toISOString(),
      completedAt: null,
    };

    // Persist to escorts table
    if (db) {
      db.upsertEscort(escort);
    }

    // Launch via processManager.sortie() with /escort skill + gate phase context
    const escortEnv: Record<string, string> = {
      VIBE_ADMIRAL_MAIN_REPO: parentShip.repo,
      VIBE_ADMIRAL_SHIP_ID: escortId,
      VIBE_ADMIRAL_ENGINE_PORT: process.env.ENGINE_PORT ?? "9721",
      VIBE_ADMIRAL_PARENT_SHIP_ID: parentShip.id,
      ...(gatePrompt ? { VIBE_ADMIRAL_GATE_PROMPT: gatePrompt } : {}),
    };

    const gateContext = gatePhase
      ? `\n\n[Gate Context] The parent Ship is currently in ${gatePhase}. Execute the ${gatePhase} review, submit the verdict, and exit.`
      : "";

    this.processManager.sortie(
      escortId,
      parentShip.worktreePath,
      parentShip.issueNumber,
      [extraPrompt, gateContext].filter(Boolean).join("\n\n") || undefined,
      "/escort",
      escortEnv,
    );

    return escortId;
  }

  /**
   * Resume an existing Escort for a subsequent gate phase.
   * Uses `--resume sessionId` to preserve context from prior gate reviews.
   */
  private resumeEscort(
    existingEscort: EscortProcess,
    parentShip: { id: string; repo: string; worktreePath: string },
    gatePhase: GatePhase,
    gatePrompt?: string,
  ): string {
    if (!existingEscort.sessionId) {
      throw new Error(`Cannot resume Escort ${existingEscort.id.slice(0, 8)}... — no sessionId`);
    }

    const escortId = existingEscort.id;

    // Build Escort env vars
    const escortEnv: Record<string, string> = {
      VIBE_ADMIRAL_MAIN_REPO: parentShip.repo,
      VIBE_ADMIRAL_SHIP_ID: escortId,
      VIBE_ADMIRAL_ENGINE_PORT: process.env.ENGINE_PORT ?? "9721",
      VIBE_ADMIRAL_PARENT_SHIP_ID: parentShip.id,
      ...(gatePrompt ? { VIBE_ADMIRAL_GATE_PROMPT: gatePrompt } : {}),
    };

    // Resume with gate context message
    const resumeMessage = `The parent Ship has entered ${gatePhase}. Execute the ${gatePhase} review, submit the verdict, and exit.`;

    this.processManager.resumeSession(
      escortId,
      existingEscort.sessionId,
      resumeMessage,
      parentShip.worktreePath,
      escortEnv,
    );

    return escortId;
  }

  /** Check if an Escort process is currently running for a parent Ship. */
  isEscortRunning(parentShipId: string): boolean {
    const escortId = this.escorts.get(parentShipId);
    if (!escortId) {
      // Check DB for restored Escorts (after Engine restart)
      const db = this.getDatabase();
      const escort = db?.getEscortByShipId(parentShipId);
      if (escort) {
        this.escorts.set(parentShipId, escort.id);
        return this.processManager.isRunning(escort.id);
      }
      return false;
    }
    return this.processManager.isRunning(escortId);
  }

  /** Kill the Escort for a parent Ship. */
  killEscort(parentShipId: string): boolean {
    const escortId = this.escorts.get(parentShipId);
    if (!escortId) return false;
    const killed = this.processManager.kill(escortId);
    this.escorts.delete(parentShipId);
    return killed;
  }

  /**
   * Clean up the Escort when the parent Ship reaches "done".
   * 1. Resolve Escort ID (in-memory map, then DB fallback)
   * 2. Kill the Escort process
   * 3. Mark the Escort's DB record as done
   */
  cleanupForDoneShip(parentShipId: string): void {
    const db = this.getDatabase();

    // Resolve Escort ID: prefer in-memory map, fall back to DB
    let escortId = this.escorts.get(parentShipId);
    if (!escortId) {
      const escort = db?.getEscortByShipId(parentShipId);
      if (escort) {
        escortId = escort.id;
      }
    }
    if (!escortId) return;

    // Kill Escort process (idempotent if already dead)
    this.processManager.kill(escortId);
    this.escorts.delete(parentShipId);

    // Mark Escort DB record as done
    db?.updateEscortPhase(escortId, "done", new Date().toISOString());

    console.log(
      `[escort-manager] Cleaned up Escort ${escortId.slice(0, 8)}... for done Ship ${parentShipId.slice(0, 8)}...`,
    );
  }

  /** Check if a process ID belongs to an Escort. */
  isEscortProcess(processId: string): boolean {
    // Check in-memory map
    for (const escortId of this.escorts.values()) {
      if (escortId === processId) return true;
    }
    // Check DB
    const db = this.getDatabase();
    const escort = db?.getEscortById(processId);
    return escort !== undefined;
  }

  /** Find the parent Ship ID for an Escort process ID. */
  findShipIdByEscortId(escortShipId: string): string | undefined {
    for (const [parentId, escortId] of this.escorts) {
      if (escortId === escortShipId) return parentId;
    }
    // Fallback: check DB
    const db = this.getDatabase();
    const escort = db?.getEscortById(escortShipId);
    if (escort) {
      this.escorts.set(escort.shipId, escortShipId);
      return escort.shipId;
    }
    return undefined;
  }

  /** Update an Escort's session ID in the DB. */
  setEscortSessionId(escortId: string, sessionId: string): void {
    const db = this.getDatabase();
    db?.updateEscortSessionId(escortId, sessionId);
  }

  /**
   * Handle Escort process exit.
   *
   * In the on-demand model, Escort exit is expected after each gate review
   * (verdict submitted → process exits normally). We only treat it as an error
   * if the parent Ship is still in a gate phase (verdict not submitted).
   */
  onEscortExit(escortShipId: string, code: number | null): void {
    const parentShipId = this.findShipIdByEscortId(escortShipId);
    if (!parentShipId) return;

    // Remove from active process tracking (but preserve DB record for session resume)
    this.escorts.delete(parentShipId);

    console.log(
      `[escort-manager] Escort ${escortShipId.slice(0, 8)}... exited (code=${code}) for parent Ship ${parentShipId.slice(0, 8)}...`,
    );

    const db = this.getDatabase();
    if (!db) return;

    const parentShip = db.getShipById(parentShipId);
    if (!parentShip) return;

    const currentPhase = parentShip.phase as Phase;
    if (!isGatePhase(currentPhase)) {
      // Phase already moved past gate — verdict was submitted successfully.
      // This is the normal path in the on-demand model.
      this.shipManager.clearGateCheck(parentShipId);
      return;
    }

    // Escort died without submitting verdict while parent is in gate phase — treat as rejection
    const prevPhase = GATE_PREV_PHASE[currentPhase as GatePhase];
    console.warn(
      `[escort-manager] Escort ${escortShipId.slice(0, 8)}... died without verdict — reverting Ship ${parentShipId.slice(0, 8)}... from ${currentPhase} to ${prevPhase}`,
    );

    // XState is the sole authority: request transition through XState first
    const feedback = `Escort process exited unexpectedly (code=${code}) without submitting verdict`;
    const result = this.actorManager?.requestTransition(parentShipId, {
      type: "ESCORT_DIED",
      exitCode: code,
      feedback,
    });

    // If XState approved the revert, persist to DB
    if (result?.success) {
      try {
        db.persistPhaseTransition(parentShipId, result.fromPhase, result.toPhase, "escort", {
          gate_result: "rejected",
          feedback,
        });
        this.shipManager.syncPhaseFromDb(parentShipId);
      } catch (err) {
        console.error(`[escort-manager] Failed to persist phase revert for Ship ${parentShipId.slice(0, 8)}...:`, err);
      }
    } else {
      console.error(`[escort-manager] XState rejected ESCORT_DIED for Ship ${parentShipId.slice(0, 8)}... (current: ${result?.currentPhase})`);
    }

    // Clear gate check state
    this.shipManager.clearGateCheck(parentShipId);

    // Notify Flagship
    const message = `Escort died without verdict for Ship #${parentShip.issueNumber} (${parentShip.issueTitle}) during ${currentPhase}. Phase reverted to ${prevPhase}. (exit code=${code})`;
    this.onEscortDeathCallback?.(parentShipId, message);
  }

  /** Kill all running Escort processes. */
  killAll(): void {
    for (const [parentShipId, escortId] of this.escorts) {
      this.processManager.kill(escortId);
      this.escorts.delete(parentShipId);
    }
  }
}
