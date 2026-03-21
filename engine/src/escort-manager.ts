import type { ProcessManager } from "./process-manager.js";
import type { ShipManager } from "./ship-manager.js";
import type { GatePhase, GateType } from "./types.js";

/** Maps gate phases to the skill name that the Escort CLI should invoke. */
const GATE_SKILL_MAP: Record<GatePhase, string> = {
  "planning-gate": "gate-plan-review",
  "implementing-gate": "gate-code-review",
  "acceptance-test-gate": "gate-code-review", // placeholder — playwright not yet implemented
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
 * 1. Engine detects gate phase via ShipRequestHandler
 * 2. EscortManager.launchEscort() spawns a Claude CLI process with the
 *    appropriate gate skill (e.g. /gate-plan-review)
 * 3. Escort performs review, writes gate-response to DB
 * 4. Ship polls DB for gate-response
 * 5. On Escort process exit, EscortManager cleans up tracking state
 */
export class EscortManager {
  private processManager: ProcessManager;
  private shipManager: ShipManager;
  /** Active Escort processes indexed by shipId (one Escort per Ship at a time). */
  private escorts = new Map<string, EscortInfo>();

  constructor(processManager: ProcessManager, shipManager: ShipManager) {
    this.processManager = processManager;
    this.shipManager = shipManager;
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
    };

    // Get DB path from Ship's environment (ShipManager stores it)
    const dbPath = this.shipManager.getDbPath();
    if (dbPath) {
      escortEnv.VIBE_ADMIRAL_DB_PATH = dbPath;
    }

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

  /** Handle Escort process exit. Cleans up tracking state. */
  onEscortExit(escortId: string, code: number | null): void {
    const shipId = this.findShipIdByEscortId(escortId);
    if (!shipId) return;

    const info = this.escorts.get(shipId);
    this.escorts.delete(shipId);

    console.log(
      `[escort-manager] Escort ${escortId} exited (code=${code}) for Ship ${shipId.slice(0, 8)}... gate=${info?.gatePhase}`,
    );
  }

  /** Kill all running Escort processes. */
  killAll(): void {
    for (const [shipId, info] of this.escorts) {
      this.processManager.kill(info.escortId);
      this.escorts.delete(shipId);
    }
  }
}
