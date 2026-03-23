import type { ProcessManager } from "./process-manager.js";
import type { ShipManager } from "./ship-manager.js";
import type { FleetDatabase } from "./db.js";
import type { ShipActorManager } from "./ship-actor-manager.js";
import type { GatePhase, GateType, Phase } from "./types.js";
import { isGatePhase, GATE_PREV_PHASE } from "./types.js";

/**
 * Thin coordination layer for persistent Escort Ships.
 *
 * Escort is "just another Ship with a different skill" — launched via
 * ShipManager.sortieEscort() at parent Ship's sortie time.
 *
 * EscortManager's responsibilities:
 * 1. Track parentShipId → escortShipId mapping (in-memory)
 * 2. Launch persistent Escort via ShipManager.sortieEscort()
 * 3. Handle Escort-Ship exit (gate revert if verdict not submitted)
 * 4. Kill Escort when parent Ship completes
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
   * Launch a persistent Escort Ship for a parent Ship.
   * Called once at parent Ship's sortie time.
   * Returns the escort Ship ID if launched, null if an Escort already exists.
   */
  launchEscort(
    parentShipId: string,
    _gatePhase?: GatePhase,
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
      const escort = this.shipManager.sortieEscort(parentShip, extraPrompt);
      this.escorts.set(parentShipId, escort.id);

      console.log(
        `[escort-manager] Launched persistent Escort ${escort.id.slice(0, 8)}... for Ship ${parentShipId.slice(0, 8)}... (issue #${parentShip.issueNumber})`,
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
   * If the parent Ship is still in a gate phase (verdict not submitted),
   * treat as rejection: revert phase and notify Flagship.
   */
  onEscortExit(escortShipId: string, code: number | null): void {
    const parentShipId = this.findShipIdByEscortId(escortShipId);
    if (!parentShipId) return;

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
      // Phase already moved past gate — verdict was submitted successfully
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
