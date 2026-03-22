import type { ShipManager } from "./ship-manager.js";
import type { ProcessManager } from "./process-manager.js";
import type { EscortManager } from "./escort-manager.js";
import type { LookoutAlertType, ShipProcess } from "./types.js";

export interface LookoutAlert {
  shipId: string;
  alertType: LookoutAlertType;
  message: string;
  issueNumber: number;
  issueTitle: string;
  fleetId: string;
}

const GATE_WAIT_STALL_MS = 3 * 60 * 1000;
const NO_OUTPUT_STALL_MS = 3 * 60 * 1000;
const EXCESSIVE_RETRY_THRESHOLD = 2;
const REALERT_INTERVAL_MS = 10 * 60 * 1000;
const SCAN_INTERVAL_MS = 30_000;

export class Lookout {
  private shipManager: ShipManager;
  private processManager: ProcessManager;
  private escortManager: EscortManager;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onAlert: ((alert: LookoutAlert) => void) | null = null;
  private alertsSent = new Map<string, number>();

  constructor(shipManager: ShipManager, processManager: ProcessManager, escortManager: EscortManager) {
    this.shipManager = shipManager;
    this.processManager = processManager;
    this.escortManager = escortManager;
  }

  setAlertHandler(handler: (alert: LookoutAlert) => void): void {
    this.onAlert = handler;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.scan(), SCAN_INTERVAL_MS);
    this.timer.unref();
    console.log("[lookout] Started periodic scan");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[lookout] Stopped periodic scan");
    }
  }

  private scan(): void {
    const ships = this.shipManager.getAllShips();
    const activeShips = ships.filter((s) => s.phase !== "done" && s.phase !== "stopped");

    if (activeShips.length === 0) return;

    const now = Date.now();

    for (const ship of activeShips) {
      this.checkGateWaitStall(ship, now);
      this.checkNoOutputStall(ship, now);
      this.checkExcessiveRetries(ship, now);
      this.checkEscortDeath(ship, now);
    }

    const activeIds = new Set(activeShips.map((s) => s.id));
    for (const key of this.alertsSent.keys()) {
      const shipId = key.split(":")[0] ?? "";
      if (!activeIds.has(shipId)) {
        this.alertsSent.delete(key);
      }
    }
  }

  private checkGateWaitStall(ship: ShipProcess, now: number): void {
    if (!ship.gateCheck || ship.gateCheck.status !== "pending") return;

    const waitMs = now - new Date(ship.gateCheck.requestedAt).getTime();
    if (waitMs < GATE_WAIT_STALL_MS) return;

    const waitMin = Math.round(waitMs / 60_000);
    this.emitAlert(ship, "gate-wait-stall", now,
      `Ship #${ship.issueNumber} (${ship.issueTitle}) has been waiting for gate response (${ship.gateCheck.gatePhase}) for ${waitMin} minutes`,
    );
  }

  private checkNoOutputStall(ship: ShipProcess, now: number): void {
    if (ship.isCompacting) return;
    if (!this.processManager.isRunning(ship.id)) return;
    if (!ship.lastOutputAt) return;

    const silenceMs = now - ship.lastOutputAt;
    if (silenceMs < NO_OUTPUT_STALL_MS) return;

    const silenceMin = Math.round(silenceMs / 60_000);
    this.emitAlert(ship, "no-output-stall", now,
      `Ship #${ship.issueNumber} (${ship.issueTitle}) has produced no output for ${silenceMin} minutes (phase: ${ship.phase})`,
    );
  }

  private checkExcessiveRetries(ship: ShipProcess, now: number): void {
    if (ship.retryCount < EXCESSIVE_RETRY_THRESHOLD) return;

    this.emitAlert(ship, "excessive-retries", now,
      `Ship #${ship.issueNumber} (${ship.issueTitle}) has retried ${ship.retryCount} times (phase: ${ship.phase})`,
    );
  }

  private checkEscortDeath(ship: ShipProcess, now: number): void {
    if (!ship.gateCheck || ship.gateCheck.status !== "pending") return;
    if (this.escortManager.isEscortRunning(ship.id)) return;

    this.emitAlert(ship, "escort-death", now,
      `Ship #${ship.issueNumber} (${ship.issueTitle}): Escort process not found for pending gate check (${ship.gateCheck.gatePhase})`,
    );
  }

  private emitAlert(
    ship: ShipProcess,
    alertType: LookoutAlertType,
    now: number,
    message: string,
  ): void {
    const key = `${ship.id}:${alertType}`;
    const lastSent = this.alertsSent.get(key);
    if (lastSent && now - lastSent < REALERT_INTERVAL_MS) return;

    this.alertsSent.set(key, now);
    console.log(`[lookout] Alert: ${message}`);

    this.onAlert?.({
      shipId: ship.id,
      alertType,
      message,
      issueNumber: ship.issueNumber,
      issueTitle: ship.issueTitle,
      fleetId: ship.fleetId,
    });
  }
}
