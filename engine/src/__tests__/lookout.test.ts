import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Lookout } from "../lookout.js";
import type { LookoutAlert, LookoutConfig } from "../lookout.js";
import type { ShipProcess, GateCheckState } from "../types.js";

type MockShipManager = {
  getAllShips: ReturnType<typeof vi.fn>;
  getShip: ReturnType<typeof vi.fn>;
};

type MockProcessManager = {
  isRunning: ReturnType<typeof vi.fn>;
};

type MockEscortManager = {
  isEscortRunning: ReturnType<typeof vi.fn>;
};

function makeShip(overrides: Partial<ShipProcess> = {}): ShipProcess {
  return {
    id: "ship-001",
    fleetId: "fleet-1",
    repo: "owner/repo",
    issueNumber: 42,
    issueTitle: "Test issue",
    phase: "coding",
    isCompacting: false,
    branchName: "feature/42-test",
    worktreePath: "/repo/.worktrees/feature/42-test",
    sessionId: null,
    prUrl: null,
    prReviewStatus: null,
    gateCheck: null,
    qaRequired: true,
    retryCount: 0,
    createdAt: new Date().toISOString(),
    lastOutputAt: null,
    ...overrides,
  };
}

function makeGateCheck(overrides: Partial<GateCheckState> = {}): GateCheckState {
  return {
    gatePhase: "plan-gate",
    gateType: "plan-review",
    status: "pending",
    requestedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createLookout(
  mocks: { shipManager: MockShipManager; processManager: MockProcessManager; escortManager: MockEscortManager },
  config?: LookoutConfig,
): Lookout {
  return new Lookout(
    mocks.shipManager as unknown as ConstructorParameters<typeof Lookout>[0],
    mocks.processManager as unknown as ConstructorParameters<typeof Lookout>[1],
    mocks.escortManager as unknown as ConstructorParameters<typeof Lookout>[2],
    config,
  );
}

describe("Lookout", () => {
  let lookout: Lookout;
  let mockShipManager: MockShipManager;
  let mockProcessManager: MockProcessManager;
  let mockEscortManager: MockEscortManager;
  let alertBatches: LookoutAlert[][];

  beforeEach(() => {
    vi.useFakeTimers();
    alertBatches = [];
    mockShipManager = {
      getAllShips: vi.fn().mockReturnValue([]),
      getShip: vi.fn(),
    };
    mockProcessManager = {
      isRunning: vi.fn().mockReturnValue(true),
    };
    mockEscortManager = {
      isEscortRunning: vi.fn().mockReturnValue(true),
    };
    lookout = createLookout({ mockShipManager, mockProcessManager, mockEscortManager } as never);
    // Reassign with correct reference
    lookout = createLookout(
      { shipManager: mockShipManager, processManager: mockProcessManager, escortManager: mockEscortManager },
    );
    lookout.setAlertBatchHandler((batch) => alertBatches.push(batch));
  });

  afterEach(() => {
    lookout.stop();
    vi.useRealTimers();
  });

  // Helper to flatten all alerts
  function allAlerts(): LookoutAlert[] {
    return alertBatches.flat();
  }

  describe("start / stop", () => {
    it("starts periodic scanning and stop clears it", () => {
      lookout.start();
      // Should not throw on double start
      lookout.start();

      lookout.stop();
      lookout.stop(); // double stop is safe
    });
  });

  describe("gate-wait-stall", () => {
    it("alerts when a Ship has been waiting for gate response > 10 minutes", () => {
      const staleRequestTime = new Date(Date.now() - 11 * 60 * 1000).toISOString();
      const ship = makeShip({
        gateCheck: makeGateCheck({ requestedAt: staleRequestTime }),
      });
      mockShipManager.getAllShips.mockReturnValue([ship]);

      lookout.start();
      vi.advanceTimersByTime(30_000); // trigger scan

      expect(allAlerts()).toHaveLength(1);
      expect(allAlerts()[0]!.alertType).toBe("gate-wait-stall");
      expect(allAlerts()[0]!.severity).toBe("warning");
      expect(allAlerts()[0]!.shipId).toBe("ship-001");
      expect(allAlerts()[0]!.message).toContain("waiting for gate response");
    });

    it("does not alert when gate wait is < 10 minutes", () => {
      const recentRequestTime = new Date(Date.now() - 1 * 60 * 1000).toISOString();
      const ship = makeShip({
        gateCheck: makeGateCheck({ requestedAt: recentRequestTime }),
      });
      mockShipManager.getAllShips.mockReturnValue([ship]);

      lookout.start();
      vi.advanceTimersByTime(30_000);

      expect(allAlerts()).toHaveLength(0);
    });

    it("does not alert for approved gates", () => {
      const staleRequestTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const ship = makeShip({
        gateCheck: makeGateCheck({ requestedAt: staleRequestTime, status: "approved" }),
      });
      mockShipManager.getAllShips.mockReturnValue([ship]);

      lookout.start();
      vi.advanceTimersByTime(30_000);

      expect(allAlerts()).toHaveLength(0);
    });
  });

  describe("no-output-stall", () => {
    it("alerts when Ship has no output for > 10 minutes and process is running", () => {
      const ship = makeShip({
        lastOutputAt: Date.now() - 11 * 60 * 1000,
      });
      mockShipManager.getAllShips.mockReturnValue([ship]);
      mockProcessManager.isRunning.mockReturnValue(true);

      // Use minSeverity: "info" so info alerts are not filtered
      lookout = createLookout(
        { shipManager: mockShipManager, processManager: mockProcessManager, escortManager: mockEscortManager },
        { minSeverity: "info" },
      );
      lookout.setAlertBatchHandler((batch) => alertBatches.push(batch));
      lookout.start();
      vi.advanceTimersByTime(30_000);

      expect(allAlerts()).toHaveLength(1);
      expect(allAlerts()[0]!.alertType).toBe("no-output-stall");
      expect(allAlerts()[0]!.severity).toBe("info");
    });

    it("does not alert when Ship is compacting", () => {
      const ship = makeShip({
        lastOutputAt: Date.now() - 10 * 60 * 1000,
        isCompacting: true,
      });
      mockShipManager.getAllShips.mockReturnValue([ship]);

      lookout = createLookout(
        { shipManager: mockShipManager, processManager: mockProcessManager, escortManager: mockEscortManager },
        { minSeverity: "info" },
      );
      lookout.setAlertBatchHandler((batch) => alertBatches.push(batch));
      lookout.start();
      vi.advanceTimersByTime(30_000);

      expect(allAlerts()).toHaveLength(0);
    });

    it("does not alert when process is not running", () => {
      const ship = makeShip({
        lastOutputAt: Date.now() - 10 * 60 * 1000,
      });
      mockShipManager.getAllShips.mockReturnValue([ship]);
      mockProcessManager.isRunning.mockReturnValue(false);

      lookout = createLookout(
        { shipManager: mockShipManager, processManager: mockProcessManager, escortManager: mockEscortManager },
        { minSeverity: "info" },
      );
      lookout.setAlertBatchHandler((batch) => alertBatches.push(batch));
      lookout.start();
      vi.advanceTimersByTime(30_000);

      expect(allAlerts()).toHaveLength(0);
    });

    it("does not alert when lastOutputAt is null", () => {
      const ship = makeShip({ lastOutputAt: null });
      mockShipManager.getAllShips.mockReturnValue([ship]);

      lookout = createLookout(
        { shipManager: mockShipManager, processManager: mockProcessManager, escortManager: mockEscortManager },
        { minSeverity: "info" },
      );
      lookout.setAlertBatchHandler((batch) => alertBatches.push(batch));
      lookout.start();
      vi.advanceTimersByTime(30_000);

      expect(allAlerts()).toHaveLength(0);
    });
  });

  describe("excessive-retries", () => {
    it("alerts when retry count >= 2", () => {
      const ship = makeShip({ retryCount: 2 });
      mockShipManager.getAllShips.mockReturnValue([ship]);

      lookout.start();
      vi.advanceTimersByTime(30_000);

      expect(allAlerts()).toHaveLength(1);
      expect(allAlerts()[0]!.alertType).toBe("excessive-retries");
      expect(allAlerts()[0]!.severity).toBe("critical");
      expect(allAlerts()[0]!.message).toContain("retried 2 times");
    });

    it("does not alert when retry count < 2", () => {
      const ship = makeShip({ retryCount: 1 });
      mockShipManager.getAllShips.mockReturnValue([ship]);

      lookout.start();
      vi.advanceTimersByTime(30_000);

      expect(allAlerts()).toHaveLength(0);
    });
  });

  describe("escort-death", () => {
    it("alerts when gate is pending but escort is not running", () => {
      const ship = makeShip({
        gateCheck: makeGateCheck({ status: "pending" }),
      });
      mockShipManager.getAllShips.mockReturnValue([ship]);
      mockEscortManager.isEscortRunning.mockReturnValue(false);

      lookout.start();
      vi.advanceTimersByTime(30_000);

      // Will also fire gate-wait-stall if requestedAt is old enough
      const escortDeathAlert = allAlerts().find((a) => a.alertType === "escort-death");
      expect(escortDeathAlert).toBeDefined();
      expect(escortDeathAlert!.severity).toBe("critical");
      expect(escortDeathAlert!.message).toContain("Escort process not found");
    });

    it("does not alert when escort is running", () => {
      const ship = makeShip({
        gateCheck: makeGateCheck({ status: "pending" }),
      });
      mockShipManager.getAllShips.mockReturnValue([ship]);
      mockEscortManager.isEscortRunning.mockReturnValue(true);

      lookout.start();
      vi.advanceTimersByTime(30_000);

      // Should only fire gate-wait-stall if requestedAt is old, not escort-death
      const escortDeathAlert = allAlerts().find((a) => a.alertType === "escort-death");
      expect(escortDeathAlert).toBeUndefined();
    });
  });

  describe("severity-aware debounce", () => {
    it("suppresses critical alerts within 10 minutes", () => {
      const ship = makeShip({ retryCount: 3 });
      mockShipManager.getAllShips.mockReturnValue([ship]);

      lookout.start();

      // First scan — should alert
      vi.advanceTimersByTime(30_000);
      expect(allAlerts()).toHaveLength(1);

      // Second scan (30s later) — should be suppressed
      vi.advanceTimersByTime(30_000);
      expect(allAlerts()).toHaveLength(1);

      // 9 minutes later — still suppressed
      vi.advanceTimersByTime(9 * 60 * 1000);
      expect(allAlerts()).toHaveLength(1);
    });

    it("re-alerts critical after 10 minutes", () => {
      const ship = makeShip({ retryCount: 3 });
      mockShipManager.getAllShips.mockReturnValue([ship]);

      lookout.start();

      // First alert
      vi.advanceTimersByTime(30_000);
      expect(allAlerts()).toHaveLength(1);

      // Wait 10+ minutes then scan again
      vi.advanceTimersByTime(11 * 60 * 1000);
      expect(allAlerts()).toHaveLength(2);
    });

    it("suppresses warning alerts within 20 minutes", () => {
      const staleRequestTime = new Date(Date.now() - 11 * 60 * 1000).toISOString();
      const ship = makeShip({
        gateCheck: makeGateCheck({ requestedAt: staleRequestTime }),
      });
      mockShipManager.getAllShips.mockReturnValue([ship]);

      lookout.start();

      // First alert at t=30s
      vi.advanceTimersByTime(30_000);
      expect(allAlerts()).toHaveLength(1);

      // 15 minutes later — still suppressed (warning debounce = 20 min)
      vi.advanceTimersByTime(15 * 60 * 1000);
      expect(allAlerts()).toHaveLength(1);

      // 21 minutes after first — re-alert
      vi.advanceTimersByTime(6 * 60 * 1000);
      expect(allAlerts()).toHaveLength(2);
    });

    it("suppresses info alerts within 30 minutes", () => {
      const ship = makeShip({
        lastOutputAt: Date.now() - 11 * 60 * 1000,
      });
      mockShipManager.getAllShips.mockReturnValue([ship]);
      mockProcessManager.isRunning.mockReturnValue(true);

      lookout = createLookout(
        { shipManager: mockShipManager, processManager: mockProcessManager, escortManager: mockEscortManager },
        { minSeverity: "info" },
      );
      lookout.setAlertBatchHandler((batch) => alertBatches.push(batch));
      lookout.start();

      // First alert
      vi.advanceTimersByTime(30_000);
      expect(allAlerts()).toHaveLength(1);

      // 25 minutes later — still suppressed (info debounce = 30 min)
      vi.advanceTimersByTime(25 * 60 * 1000);
      expect(allAlerts()).toHaveLength(1);

      // 31 minutes after first — re-alert
      vi.advanceTimersByTime(6 * 60 * 1000);
      expect(allAlerts()).toHaveLength(2);
    });
  });

  describe("severity filtering (minSeverity)", () => {
    it("filters out info alerts when minSeverity is warning (default)", () => {
      const ship = makeShip({
        lastOutputAt: Date.now() - 11 * 60 * 1000,
      });
      mockShipManager.getAllShips.mockReturnValue([ship]);
      mockProcessManager.isRunning.mockReturnValue(true);

      // Default minSeverity = "warning"
      lookout.start();
      vi.advanceTimersByTime(30_000);

      // no-output-stall is "info" severity — should be filtered
      expect(allAlerts()).toHaveLength(0);
    });

    it("passes info alerts when minSeverity is info", () => {
      const ship = makeShip({
        lastOutputAt: Date.now() - 11 * 60 * 1000,
      });
      mockShipManager.getAllShips.mockReturnValue([ship]);
      mockProcessManager.isRunning.mockReturnValue(true);

      lookout = createLookout(
        { shipManager: mockShipManager, processManager: mockProcessManager, escortManager: mockEscortManager },
        { minSeverity: "info" },
      );
      lookout.setAlertBatchHandler((batch) => alertBatches.push(batch));
      lookout.start();
      vi.advanceTimersByTime(30_000);

      expect(allAlerts()).toHaveLength(1);
    });

    it("filters warning and info when minSeverity is critical", () => {
      const staleRequestTime = new Date(Date.now() - 11 * 60 * 1000).toISOString();
      const ship = makeShip({
        lastOutputAt: Date.now() - 11 * 60 * 1000,
        gateCheck: makeGateCheck({ requestedAt: staleRequestTime }),
        retryCount: 3,
      });
      mockShipManager.getAllShips.mockReturnValue([ship]);
      mockProcessManager.isRunning.mockReturnValue(true);
      mockEscortManager.isEscortRunning.mockReturnValue(true);

      lookout = createLookout(
        { shipManager: mockShipManager, processManager: mockProcessManager, escortManager: mockEscortManager },
        { minSeverity: "critical" },
      );
      lookout.setAlertBatchHandler((batch) => alertBatches.push(batch));
      lookout.start();
      vi.advanceTimersByTime(30_000);

      // Only critical alerts should pass: excessive-retries
      // gate-wait-stall (warning) and no-output-stall (info) should be filtered
      const alerts = allAlerts();
      expect(alerts.every((a) => a.severity === "critical")).toBe(true);
      expect(alerts.find((a) => a.alertType === "excessive-retries")).toBeDefined();
    });
  });

  describe("batch emission", () => {
    it("emits multiple alerts as a single batch per scan", () => {
      const ship1 = makeShip({ id: "ship-001", retryCount: 3 });
      const ship2 = makeShip({ id: "ship-002", retryCount: 5, issueNumber: 99, issueTitle: "Other issue" });
      mockShipManager.getAllShips.mockReturnValue([ship1, ship2]);

      lookout.start();
      vi.advanceTimersByTime(30_000);

      // Should be exactly 1 batch with 2 alerts
      expect(alertBatches).toHaveLength(1);
      expect(alertBatches[0]).toHaveLength(2);
    });

    it("does not emit batch when no alerts triggered", () => {
      mockShipManager.getAllShips.mockReturnValue([makeShip()]);

      lookout.start();
      vi.advanceTimersByTime(30_000);

      expect(alertBatches).toHaveLength(0);
    });
  });

  describe("skips done/paused/abandoned Ships", () => {
    it("does not scan Ships in done phase", () => {
      const ship = makeShip({ phase: "done", retryCount: 5 });
      mockShipManager.getAllShips.mockReturnValue([ship]);

      lookout.start();
      vi.advanceTimersByTime(30_000);

      expect(allAlerts()).toHaveLength(0);
    });

    it("does not scan Ships in paused phase", () => {
      const ship = makeShip({ phase: "paused", retryCount: 5 });
      mockShipManager.getAllShips.mockReturnValue([ship]);

      lookout.start();
      vi.advanceTimersByTime(30_000);

      expect(allAlerts()).toHaveLength(0);
    });
  });

  describe("cleanup stale alert tracking", () => {
    it("re-alerts after Ship leaves and returns (cleanup clears tracking)", () => {
      const ship = makeShip({ retryCount: 3 });

      lookout.start();

      // First scan — Ship active, should alert
      mockShipManager.getAllShips.mockReturnValue([ship]);
      vi.advanceTimersByTime(30_000);
      expect(allAlerts()).toHaveLength(1);

      // Second scan — Ship gone, should clean up alert key
      mockShipManager.getAllShips.mockReturnValue([]);
      vi.advanceTimersByTime(30_000);
      expect(allAlerts()).toHaveLength(1);

      // Third scan — Ship comes back, alert key was cleaned up so alert fires again
      mockShipManager.getAllShips.mockReturnValue([ship]);
      vi.advanceTimersByTime(30_000);
      expect(allAlerts()).toHaveLength(2);
    });

    it("re-alerts after suppression interval expires for a returning Ship", () => {
      const ship = makeShip({ retryCount: 3 });

      lookout.start();

      // First scan at t=30s — alert
      mockShipManager.getAllShips.mockReturnValue([ship]);
      vi.advanceTimersByTime(30_000);
      expect(allAlerts()).toHaveLength(1);

      // Wait 10+ minutes — suppression window expires for critical
      vi.advanceTimersByTime(11 * 60 * 1000);
      expect(allAlerts()).toHaveLength(2);
    });
  });

  describe("configurable thresholds", () => {
    it("respects custom gateWaitStallMs", () => {
      const staleRequestTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
      const ship = makeShip({
        gateCheck: makeGateCheck({ requestedAt: staleRequestTime }),
      });
      mockShipManager.getAllShips.mockReturnValue([ship]);

      // 5-minute threshold instead of default 10
      lookout = createLookout(
        { shipManager: mockShipManager, processManager: mockProcessManager, escortManager: mockEscortManager },
        { gateWaitStallMs: 5 * 60 * 1000 },
      );
      lookout.setAlertBatchHandler((batch) => alertBatches.push(batch));
      lookout.start();
      vi.advanceTimersByTime(30_000);

      expect(allAlerts()).toHaveLength(1);
      expect(allAlerts()[0]!.alertType).toBe("gate-wait-stall");
    });

    it("respects custom scanIntervalMs", () => {
      const ship = makeShip({ retryCount: 3 });
      mockShipManager.getAllShips.mockReturnValue([ship]);

      lookout = createLookout(
        { shipManager: mockShipManager, processManager: mockProcessManager, escortManager: mockEscortManager },
        { scanIntervalMs: 60_000 },
      );
      lookout.setAlertBatchHandler((batch) => alertBatches.push(batch));
      lookout.start();

      // No alert at 30s with 60s interval
      vi.advanceTimersByTime(30_000);
      expect(allAlerts()).toHaveLength(0);

      // Alert at 60s
      vi.advanceTimersByTime(30_000);
      expect(allAlerts()).toHaveLength(1);
    });
  });

  describe("no alert handler set", () => {
    it("does not throw when no alert handler is configured", () => {
      const noHandlerLookout = createLookout(
        { shipManager: mockShipManager, processManager: mockProcessManager, escortManager: mockEscortManager },
      );
      // Don't set alert handler

      const ship = makeShip({ retryCount: 5 });
      mockShipManager.getAllShips.mockReturnValue([ship]);

      noHandlerLookout.start();
      expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
      noHandlerLookout.stop();
    });
  });
});
