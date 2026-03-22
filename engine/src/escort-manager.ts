import type { ProcessManager } from "./process-manager.js";
import type { ShipManager } from "./ship-manager.js";
import type { FleetDatabase } from "./db.js";
import type { GatePhase, GateType, Phase } from "./types.js";
import { isGatePhase, GATE_PREV_PHASE } from "./types.js";

/** Maps gate phases to the skill name that the Escort CLI should invoke. */
const GATE_SKILL_MAP: Record<GatePhase, string> = {
  "planning-gate": "gate-plan-review",
  "implementing-gate": "gate-code-review",
  "acceptance-test-gate": "gate-acceptance-test",
};

/** Information about a running Escort process. */
export interface EscortInfo {
  escortId: string;
  shipId: string;
  gatePhase: GatePhase;
  gateType: GateType;
  startedAt: string;
}

/**
 * Manages Escort processes — independent Claude CLI gate-review agents
 * launched by the Engine when a Ship enters a gate phase.
 *
 * Lifecycle:
 * 1. Engine detects gate phase via phase change polling
 * 2. EscortManager.launchEscort() spawns a Claude CLI process with the
 *    appropriate gate skill (e.g. /gate-plan-review)
 * 3. Escort performs review, directly updates phases table and phase_transitions
 * 4. Ship polls phases table for phase changes
 * 5. On Escort process exit, EscortManager cleans up tracking state
 */
export class EscortManager {
  private processManager: ProcessManager;
  private shipManager: ShipManager;
  private getDatabase: () => FleetDatabase | null;
  /** Active Escort processes indexed by shipId (one Escort per Ship at a time). */
  private escorts = new Map<string, EscortInfo>();
  private onEscortDeathCallback: ((shipId: string, message: string) => void) | null = null;

  constructor(processManager: ProcessManager, shipManager: ShipManager, getDatabase: () => FleetDatabase | null) {
    this.processManager = processManager;
    this.shipManager = shipManager;
    this.getDatabase = getDatabase;
  }

  /** Set callback for Escort death notifications (sent to Flagship). */
  setEscortDeathHandler(handler: (shipId: string, message: string) => void): void {
    this.onEscortDeathCallback = handler;
  }

  /**
   * Launch an Escort process for a gate phase.
   * Returns the escort ID if launched, null if an Escort is already running for this Ship.
   */
  launchEscort(
    shipId: string,
    gatePhase: GatePhase,
    gateType: GateType,
  ): string | null {
    // Prevent duplicate Escorts for the same Ship
    const existing = this.escorts.get(shipId);
    if (existing && this.processManager.isRunning(existing.escortId)) {
      console.log(
        `[escort-manager] Escort already running for Ship ${shipId.slice(0, 8)}... (${existing.escortId.slice(0, 8)}...)`,
      );
      return null;
    }

    const ship = this.shipManager.getShip(shipId);
    if (!ship) {
      console.warn(`[escort-manager] Ship ${shipId} not found — cannot launch Escort`);
      return null;
    }

    const skill = GATE_SKILL_MAP[gatePhase];
    if (!skill) {
      console.warn(`[escort-manager] No skill mapped for gate phase: ${gatePhase}`);
      return null;
    }

    const escortId = `escort-${shipId.slice(0, 8)}-${gatePhase}`;

    // Build environment variables for the Escort process
    const escortEnv: Record<string, string> = {
      VIBE_ADMIRAL_SHIP_ID: shipId,
      VIBE_ADMIRAL_MAIN_REPO: ship.repo,
      VIBE_ADMIRAL_ENGINE_PORT: process.env.ENGINE_PORT ?? "9721",
    };

    this.processManager.launchEscort(
      escortId,
      ship.worktreePath,
      skill,
      ship.issueNumber,
      escortEnv,
    );

    const info: EscortInfo = {
      escortId,
      shipId,
      gatePhase,
      gateType,
      startedAt: new Date().toISOString(),
    };
    this.escorts.set(shipId, info);

    console.log(
      `[escort-manager] Launched Escort ${escortId} for Ship ${shipId.slice(0, 8)}... — /${skill} #${ship.issueNumber}`,
    );

    return escortId;
  }

  /** Get the active Escort for a Ship, if any. */
  getEscort(shipId: string): EscortInfo | undefined {
    return this.escorts.get(shipId);
  }

  /** Check if an Escort process is currently running for a Ship. */
  isEscortRunning(shipId: string): boolean {
    const info = this.escorts.get(shipId);
    if (!info) return false;
    return this.processManager.isRunning(info.escortId);
  }

  /** Kill the Escort process for a Ship. */
  killEscort(shipId: string): boolean {
    const info = this.escorts.get(shipId);
    if (!info) return false;
    const killed = this.processManager.kill(info.escortId);
    this.escorts.delete(shipId);
    return killed;
  }

  /** Check if a process ID belongs to an Escort. */
  isEscortProcess(processId: string): boolean {
    return processId.startsWith("escort-");
  }

  /** Find the Ship ID associated with an Escort process ID. */
  findShipIdByEscortId(escortId: string): string | undefined {
    for (const [shipId, info] of this.escorts) {
      if (info.escortId === escortId) return shipId;
    }
    return undefined;
  }

  /**
   * Handle Escort process exit.
   * If the Escort exited without submitting a verdict (Ship phase is still a gate phase),
   * treat it as a rejection: revert phase to pre-gate, clear gateCheck, and notify Flagship.
   */
  onEscortExit(escortId: string, code: number | null): void {
    const shipId = this.findShipIdByEscortId(escortId);
    if (!shipId) return;

    const info = this.escorts.get(shipId);
    this.escorts.delete(shipId);

    console.log(
      `[escort-manager] Escort ${escortId} exited (code=${code}) for Ship ${shipId.slice(0, 8)}... gate=${info?.gatePhase}`,
    );

    // Check if verdict was submitted: if phase is still a gate phase, verdict was NOT submitted
    const db = this.getDatabase();
    if (!db || !info) return;

    const ship = db.getShipById(shipId);
    if (!ship) return;

    const currentPhase = ship.phase as Phase;
    if (!isGatePhase(currentPhase)) {
      // Phase already moved past gate — verdict was submitted successfully
      this.shipManager.clearGateCheck(shipId);
      return;
    }

    // Escort died without submitting verdict — treat as rejection
    const prevPhase = GATE_PREV_PHASE[currentPhase as GatePhase];
    console.warn(
      `[escort-manager] Escort ${escortId} died without verdict — reverting Ship ${shipId.slice(0, 8)}... from ${currentPhase} to ${prevPhase}`,
    );

    // Revert phase to pre-gate (reject)
    try {
      db.transitionPhase(shipId, currentPhase, prevPhase, "escort", {
        gate_result: "rejected",
        feedback: `Escort process exited unexpectedly (code=${code}) without submitting verdict`,
      });
      this.shipManager.syncPhaseFromDb(shipId);
    } catch (err) {
      console.error(`[escort-manager] Failed to revert phase for Ship ${shipId.slice(0, 8)}...:`, err);
    }

    // Clear gate check state
    this.shipManager.clearGateCheck(shipId);

    // Notify Flagship
    const message = `Escort died without verdict for Ship #${ship.issueNumber} (${ship.issueTitle}) during ${currentPhase}. Phase reverted to ${prevPhase}. (exit code=${code})`;
    this.onEscortDeathCallback?.(shipId, message);
  }

  /** Kill all running Escort processes. */
  killAll(): void {
    for (const [shipId, info] of this.escorts) {
      this.processManager.kill(info.escortId);
      this.escorts.delete(shipId);
    }
  }
}
