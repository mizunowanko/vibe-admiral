import type { ProcessManager } from "./process-manager.js";
import type { ShipManager } from "./ship-manager.js";
import type { FleetDatabase } from "./db.js";
import type { ShipActorManager } from "./ship-actor-manager.js";
import type { GatePhase, GateType, Phase } from "./types.js";
import { isGatePhase, GATE_PREV_PHASE } from "./types.js";

/**
 * On-demand Escort coordination layer using session resume.
 *
 * Escorts are launched on-demand when a gate phase is reached, perform their
 * review, submit a verdict, and exit. Session resume (`--resume sessionId`)
 * preserves context across gate phases so that planning review insights carry
 * over to code review and acceptance testing.
 *
 * Lifecycle per gate:
 *   1. Ship enters gate phase (e.g., planning-gate)
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
  /** parentShipId → escortShipId mapping (one Escort per parent Ship). */
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
   * - First gate (no existing Escort): creates a new Escort Ship and launches fresh
   * - Subsequent gates (existing Escort with sessionId): resumes the previous session
   * - If an Escort process is already running, returns null (duplicate prevention)
   *
   * Returns the escort Ship ID if launched, null if skipped or failed.
   */
  launchEscort(
    parentShipId: string,
    gatePhase?: GatePhase,
    _gateType?: GateType,
    extraPrompt?: string,
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

    try {
      // Build extra environment variables for the Escort process
      const extraEnv: Record<string, string> = {};

      // For acceptance-test-gate, read qaRequired from the planning-gate transition metadata
      if (gatePhase === "acceptance-test-gate") {
        const db = this.getDatabase();
        if (db) {
          const transitions = db.getPhaseTransitions(parentShipId, 50);
          const planningGateTransition = transitions.find(
            (t) => t.toPhase === "planning-gate",
          );
          const metadata = planningGateTransition?.metadata as Record<string, unknown> | null;
          const qaRequired = metadata?.qaRequired ?? true; // default true (conservative)
          extraEnv.VIBE_ADMIRAL_QA_REQUIRED = String(qaRequired);
        }
      }

      // Check for an existing Escort Ship (from a previous gate) with a sessionId
      const existingEscort = this.shipManager.getEscortForShip(parentShipId);

      if (existingEscort?.sessionId) {
        // Resume previous Escort session — preserves context from prior gate reviews
        const escort = this.shipManager.resumeEscort(
          existingEscort,
          gatePhase ?? "planning-gate",
          extraEnv,
        );
        this.escorts.set(parentShipId, escort.id);

        console.log(
          `[escort-manager] Resumed Escort ${escort.id.slice(0, 8)}... (session: ${existingEscort.sessionId.slice(0, 12)}...) for Ship ${parentShipId.slice(0, 8)}... at ${gatePhase ?? "unknown"} gate`,
        );

        return escort.id;
      }

      // First gate or no sessionId — launch a fresh Escort
      const escort = this.shipManager.sortieEscort(parentShip, gatePhase, extraPrompt, extraEnv);
      this.escorts.set(parentShipId, escort.id);

      console.log(
        `[escort-manager] Launched new Escort ${escort.id.slice(0, 8)}... for Ship ${parentShipId.slice(0, 8)}... at ${gatePhase ?? "unknown"} gate (issue #${parentShip.issueNumber})`,
      );

      return escort.id;
    } catch (err) {
      console.error(`[escort-manager] Failed to launch Escort for Ship ${parentShipId.slice(0, 8)}...:`, err);
      return null;
    }
  }

  /** Check if an Escort process is currently running for a parent Ship. */
  isEscortRunning(parentShipId: string): boolean {
    const escortId = this.escorts.get(parentShipId);
    if (!escortId) {
      // Check DB for restored Escort Ships (after Engine restart)
      const escort = this.shipManager.getEscortForShip(parentShipId);
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
   * 3. Mark the Escort's DB record as done (phase + completed_at)
   */
  cleanupForDoneShip(parentShipId: string): void {
    // Resolve Escort ID: prefer in-memory map, fall back to DB
    let escortId = this.escorts.get(parentShipId);
    if (!escortId) {
      const escort = this.shipManager.getEscortForShip(parentShipId);
      if (escort) {
        escortId = escort.id;
      }
    }
    if (!escortId) return;

    // Kill Escort process (idempotent if already dead)
    this.processManager.kill(escortId);
    this.escorts.delete(parentShipId);

    // Mark Escort DB record as done
    this.shipManager.updatePhase(escortId, "done");

    console.log(
      `[escort-manager] Cleaned up Escort ${escortId.slice(0, 8)}... for done Ship ${parentShipId.slice(0, 8)}...`,
    );
  }

  /** Check if a process ID belongs to an Escort Ship. */
  isEscortProcess(processId: string): boolean {
    return this.shipManager.isEscort(processId);
  }

  /** Find the parent Ship ID for an Escort Ship process ID. */
  findShipIdByEscortId(escortShipId: string): string | undefined {
    for (const [parentId, escortId] of this.escorts) {
      if (escortId === escortShipId) return parentId;
    }
    // Fallback: check DB
    const escort = this.shipManager.getShip(escortShipId);
    if (escort?.kind === "escort" && escort.parentShipId) {
      this.escorts.set(escort.parentShipId, escortShipId);
      return escort.parentShipId;
    }
    return undefined;
  }

  /**
   * Handle Escort Ship process exit.
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
