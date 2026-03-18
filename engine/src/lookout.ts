import type { ShipManager } from "./ship-manager.js";
import type { ProcessManager } from "./process-manager.js";
import type { LookoutAlertType, ShipProcess } from "./types.js";

export interface LookoutAlert {
  shipId: string;
  alertType: LookoutAlertType;
  message: string;
  issueNumber: number;
  issueTitle: string;
  fleetId: string;
}

/** Thresholds (ms) for Lookout anomaly detection. */
const GATE_WAIT_STALL_MS = 3 * 60 * 1000; // 3 minutes (early warning before 5-min reminder)
const ACCEPTANCE_TEST_STALL_MS = 5 * 60 * 1000; // 5 minutes
const NO_OUTPUT_STALL_MS = 3 * 60 * 1000; // 3 minutes
const EXCESSIVE_RETRY_THRESHOLD = 2;

/** Minimum interval before re-alerting the same anomaly for the same ship (ms). */
const REALERT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/** Scan interval (ms). */
const SCAN_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Lookout: periodic Ship health scanner.
 *
 * Detects anomalies in active Ships (gate stalls, no-output stalls,
 * acceptance-test stalls, excessive retries) and notifies Bridge via callback.
 */
export class Lookout {
  private shipManager: ShipManager;
  private processManager: ProcessManager;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onAlert: ((alert: LookoutAlert) => void) | null = null;

  /**
   * Tracks sent alerts to prevent duplicate notifications.
   * Key: `${shipId}:${alertType}`, Value: timestamp of last alert.
   */
  private alertsSent = new Map<string, number>();

  constructor(shipManager: ShipManager, processManager: ProcessManager) {
    this.shipManager = shipManager;
    this.processManager = processManager;
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
    const activeShips = ships.filter(
      (s) => s.status !== "done" && s.status !== "error",
    );

    if (activeShips.length === 0) return;

    const now = Date.now();

    for (const ship of activeShips) {
      this.checkGateWaitStall(ship, now);
      this.checkAcceptanceTestStall(ship, now);
      this.checkNoOutputStall(ship, now);
      this.checkExcessiveRetries(ship, now);
    }

    // Clean up stale alert entries for ships that are no longer active
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
      `Ship #${ship.issueNumber} (${ship.issueTitle}) has been waiting for gate response (${ship.gateCheck.transition}) for ${waitMin} minutes`,
    );
  }

  private checkAcceptanceTestStall(ship: ShipProcess, now: number): void {
    if (ship.status !== "acceptance-test" || !ship.acceptanceTest) return;
    if (ship.acceptanceTestApproved) return;

    // Use lastOutputAt as proxy for when acceptance test started waiting
    const waitSince = ship.lastOutputAt ?? new Date(ship.createdAt).getTime();
    const waitMs = now - waitSince;
    if (waitMs < ACCEPTANCE_TEST_STALL_MS) return;

    const waitMin = Math.round(waitMs / 60_000);
    this.emitAlert(ship, "acceptance-test-stall", now,
      `Ship #${ship.issueNumber} (${ship.issueTitle}) has been waiting for acceptance test response for ${waitMin} minutes`,
    );
  }

  private checkNoOutputStall(ship: ShipProcess, now: number): void {
    // Skip compacting ships — they produce no output during compaction
    if (ship.isCompacting) return;
    // Only check ships with running processes
    if (!this.processManager.isRunning(ship.id)) return;
    // Need lastOutputAt to detect stall
    if (!ship.lastOutputAt) return;

    const silenceMs = now - ship.lastOutputAt;
    if (silenceMs < NO_OUTPUT_STALL_MS) return;

    const silenceMin = Math.round(silenceMs / 60_000);
    this.emitAlert(ship, "no-output-stall", now,
      `Ship #${ship.issueNumber} (${ship.issueTitle}) has produced no output for ${silenceMin} minutes (phase: ${ship.status})`,
    );
  }

  private checkExcessiveRetries(ship: ShipProcess, now: number): void {
    if (ship.retryCount < EXCESSIVE_RETRY_THRESHOLD) return;

    this.emitAlert(ship, "excessive-retries", now,
      `Ship #${ship.issueNumber} (${ship.issueTitle}) has retried ${ship.retryCount} times (phase: ${ship.status})`,
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
