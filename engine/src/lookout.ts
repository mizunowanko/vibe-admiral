import type { ShipManager } from "./ship-manager.js";
import type { ProcessManagerLike } from "./process-manager.js";
import type { EscortManager } from "./escort-manager.js";
import type { AlertSeverity, LookoutAlertType, ShipProcess } from "./types.js";

export interface LookoutAlert {
  shipId: string;
  alertType: LookoutAlertType;
  severity: AlertSeverity;
  message: string;
  issueNumber: number;
  issueTitle: string;
  fleetId: string;
}

export interface LookoutConfig {
  minSeverity?: AlertSeverity;
  gateWaitStallMs?: number;
  noOutputStallMs?: number;
  excessiveRetryThreshold?: number;
  scanIntervalMs?: number;
}

const SEVERITY_ORDER: Record<AlertSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

const ALERT_SEVERITY: Record<LookoutAlertType, AlertSeverity> = {
  "escort-death": "critical",
  "excessive-retries": "critical",
  "gate-wait-stall": "warning",
  "no-output-stall": "info",
};

const DEBOUNCE_BY_SEVERITY: Record<AlertSeverity, number> = {
  critical: 10 * 60 * 1000,
  warning: 20 * 60 * 1000,
  info: 30 * 60 * 1000,
};

const DEFAULT_GATE_WAIT_STALL_MS = 10 * 60 * 1000;
const DEFAULT_NO_OUTPUT_STALL_MS = 10 * 60 * 1000;
const DEFAULT_EXCESSIVE_RETRY_THRESHOLD = 2;
const DEFAULT_SCAN_INTERVAL_MS = 30_000;

export class Lookout {
  private shipManager: ShipManager;
  private processManager: ProcessManagerLike;
  private escortManager: EscortManager;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onAlerts: ((alerts: LookoutAlert[]) => void) | null = null;
  private alertsSent = new Map<string, number>();

  private readonly minSeverity: AlertSeverity;
  private readonly gateWaitStallMs: number;
  private readonly noOutputStallMs: number;
  private readonly excessiveRetryThreshold: number;
  private readonly scanIntervalMs: number;

  constructor(
    shipManager: ShipManager,
    processManager: ProcessManagerLike,
    escortManager: EscortManager,
    config?: LookoutConfig,
  ) {
    this.shipManager = shipManager;
    this.processManager = processManager;
    this.escortManager = escortManager;
    this.minSeverity = config?.minSeverity ?? "warning";
    this.gateWaitStallMs = config?.gateWaitStallMs ?? DEFAULT_GATE_WAIT_STALL_MS;
    this.noOutputStallMs = config?.noOutputStallMs ?? DEFAULT_NO_OUTPUT_STALL_MS;
    this.excessiveRetryThreshold = config?.excessiveRetryThreshold ?? DEFAULT_EXCESSIVE_RETRY_THRESHOLD;
    this.scanIntervalMs = config?.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
  }

  setAlertBatchHandler(handler: (alerts: LookoutAlert[]) => void): void {
    this.onAlerts = handler;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.scan(), this.scanIntervalMs);
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
    const activeShips = ships.filter((s) => s.phase !== "done" && s.phase !== "paused" && s.phase !== "abandoned");

    // Clean up stale alert tracking for inactive Ships (even when no active Ships remain)
    const activeIds = new Set(activeShips.map((s) => s.id));
    for (const key of this.alertsSent.keys()) {
      const shipId = key.split(":")[0] ?? "";
      if (!activeIds.has(shipId)) {
        this.alertsSent.delete(key);
      }
    }

    if (activeShips.length === 0) return;

    const now = Date.now();
    const batch: LookoutAlert[] = [];

    for (const ship of activeShips) {
      this.checkGateWaitStall(ship, now, batch);
      this.checkNoOutputStall(ship, now, batch);
      this.checkExcessiveRetries(ship, now, batch);
      this.checkEscortDeath(ship, now, batch);
    }

    if (batch.length > 0 && this.onAlerts) {
      this.onAlerts(batch);
    }
  }

  private checkGateWaitStall(ship: ShipProcess, now: number, batch: LookoutAlert[]): void {
    if (!ship.gateCheck || ship.gateCheck.status !== "pending") return;

    const waitMs = now - new Date(ship.gateCheck.requestedAt).getTime();
    if (waitMs < this.gateWaitStallMs) return;

    const waitMin = Math.round(waitMs / 60_000);
    this.bufferAlert(ship, "gate-wait-stall", now, batch,
      `Ship #${ship.issueNumber} (${ship.issueTitle}) has been waiting for gate response (${ship.gateCheck.gatePhase}) for ${waitMin} minutes`,
    );
  }

  private checkNoOutputStall(ship: ShipProcess, now: number, batch: LookoutAlert[]): void {
    if (ship.isCompacting) return;
    if (!this.processManager.isRunning(ship.id)) return;
    if (!ship.lastOutputAt) return;

    const silenceMs = now - ship.lastOutputAt;
    if (silenceMs < this.noOutputStallMs) return;

    const silenceMin = Math.round(silenceMs / 60_000);
    this.bufferAlert(ship, "no-output-stall", now, batch,
      `Ship #${ship.issueNumber} (${ship.issueTitle}) has produced no output for ${silenceMin} minutes (phase: ${ship.phase})`,
    );
  }

  private checkExcessiveRetries(ship: ShipProcess, now: number, batch: LookoutAlert[]): void {
    if (ship.retryCount < this.excessiveRetryThreshold) return;

    this.bufferAlert(ship, "excessive-retries", now, batch,
      `Ship #${ship.issueNumber} (${ship.issueTitle}) has retried ${ship.retryCount} times (phase: ${ship.phase})`,
    );
  }

  private checkEscortDeath(ship: ShipProcess, now: number, batch: LookoutAlert[]): void {
    if (!ship.gateCheck || ship.gateCheck.status !== "pending") return;
    if (this.escortManager.isEscortRunning(ship.id)) return;

    this.bufferAlert(ship, "escort-death", now, batch,
      `Ship #${ship.issueNumber} (${ship.issueTitle}): Escort process not found for pending gate check (${ship.gateCheck.gatePhase})`,
    );
  }

  private bufferAlert(
    ship: ShipProcess,
    alertType: LookoutAlertType,
    now: number,
    batch: LookoutAlert[],
    message: string,
  ): void {
    const severity = ALERT_SEVERITY[alertType];

    // Filter by minimum severity
    if (SEVERITY_ORDER[severity] > SEVERITY_ORDER[this.minSeverity]) return;

    // Severity-aware debounce
    const key = `${ship.id}:${alertType}`;
    const lastSent = this.alertsSent.get(key);
    const debounceMs = DEBOUNCE_BY_SEVERITY[severity];
    if (lastSent && now - lastSent < debounceMs) return;

    this.alertsSent.set(key, now);
    console.log(`[lookout] Alert (${severity}): ${message}`);

    batch.push({
      shipId: ship.id,
      alertType,
      severity,
      message,
      issueNumber: ship.issueNumber,
      issueTitle: ship.issueTitle,
      fleetId: ship.fleetId,
    });
  }
}
