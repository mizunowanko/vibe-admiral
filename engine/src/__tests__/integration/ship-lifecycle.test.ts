import { describe, expect, it, vi, beforeEach } from "vitest";
import { ShipRequestHandler } from "../../ship-request-handler.js";
import type { ShipProcess, FleetGateSettings, ShipStatus } from "../../types.js";

/**
 * Integration test: Ship lifecycle state machine
 *
 * Tests the full Ship status progression:
 *   planning → implementing → acceptance-test → merging → done
 *
 * Includes gate check flow, backward transition rejection,
 * and the interplay between ShipRequestHandler, ShipManager, and StatusManager.
 */

type MockShipManager = {
  getShip: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
  clearGateCheck: ReturnType<typeof vi.fn>;
  setQaRequired: ReturnType<typeof vi.fn>;
  setNothingToDo: ReturnType<typeof vi.fn>;
};

type MockStatusManager = {
  syncPhaseLabel: ReturnType<typeof vi.fn>;
};

function makeShip(overrides: Partial<ShipProcess> = {}): ShipProcess {
  return {
    id: "ship-1",
    fleetId: "fleet-1",
    repo: "owner/repo",
    issueNumber: 42,
    issueTitle: "Test feature",
    status: "planning",
    isCompacting: false,
    branchName: "feature/42-test",
    worktreePath: "/tmp/worktree",
    sessionId: null,
    prUrl: null,
    prReviewStatus: null,
    acceptanceTest: null,
    acceptanceTestApproved: false,
    gateCheck: null,
    qaRequired: true,
    escortAgentId: null,
    errorType: null,
    retryCount: 0,
    createdAt: new Date().toISOString(),
    lastOutputAt: null,
    ...overrides,
  };
}

describe("Ship lifecycle (integration)", () => {
  let handler: ShipRequestHandler;
  let mockShipManager: MockShipManager;
  let mockStatusManager: MockStatusManager;

  // All gates disabled for lifecycle flow tests (gates tested separately)
  const noGates: FleetGateSettings = {
    "planning→implementing": false,
    "implementing→acceptance-test": false,
    "acceptance-test→merging": false,
  };

  beforeEach(() => {
    mockShipManager = {
      getShip: vi.fn(),
      updateStatus: vi.fn(),
      clearGateCheck: vi.fn(),
      setQaRequired: vi.fn(),
      setNothingToDo: vi.fn(),
    };
    mockStatusManager = {
      syncPhaseLabel: vi.fn().mockResolvedValue(undefined),
    };
    handler = new ShipRequestHandler(
      mockShipManager as unknown as ConstructorParameters<typeof ShipRequestHandler>[0],
      mockStatusManager as unknown as ConstructorParameters<typeof ShipRequestHandler>[1],
    );
  });

  describe("full forward progression (gates disabled)", () => {
    it("transitions planning → implementing → acceptance-test → merging → done", async () => {
      const transitions: Array<{ from: ShipStatus; to: ShipStatus }> = [
        { from: "planning", to: "implementing" },
        { from: "implementing", to: "acceptance-test" },
        { from: "acceptance-test", to: "merging" },
      ];

      for (const { from, to } of transitions) {
        mockShipManager.getShip.mockReturnValue(makeShip({ status: from }));
        const result = await handler.handle(
          "ship-1",
          { request: "status-transition", status: to },
          noGates,
        );
        expect(result.ok).toBe(true);
        expect(mockStatusManager.syncPhaseLabel).toHaveBeenCalledWith(
          "owner/repo", 42, to,
        );
        expect(mockShipManager.updateStatus).toHaveBeenCalledWith("ship-1", to);
      }

      // done is terminal — no label sync
      mockShipManager.getShip.mockReturnValue(makeShip({ status: "merging" }));
      const doneResult = await handler.handle(
        "ship-1",
        { request: "status-transition", status: "done" },
        noGates,
      );
      expect(doneResult.ok).toBe(true);
      expect(mockShipManager.updateStatus).toHaveBeenCalledWith("ship-1", "done");
    });
  });

  describe("backward transitions", () => {
    it("rejects backward transitions between phase statuses", async () => {
      const backward: Array<{ from: ShipStatus; to: ShipStatus }> = [
        { from: "implementing", to: "planning" },
        { from: "acceptance-test", to: "implementing" },
        { from: "merging", to: "acceptance-test" },
      ];

      for (const { from, to } of backward) {
        mockShipManager.getShip.mockReturnValue(makeShip({ status: from }));
        const result = await handler.handle(
          "ship-1",
          { request: "status-transition", status: to },
          noGates,
        );
        expect(result.ok).toBe(false);
        expect(result.error).toContain("Cannot go backward");
      }
    });

    it("rejects same-status transition (equal index counts as backward)", async () => {
      mockShipManager.getShip.mockReturnValue(makeShip({ status: "implementing" }));
      const result = await handler.handle(
        "ship-1",
        { request: "status-transition", status: "implementing" },
        noGates,
      );
      // Implementation uses targetIdx <= currentIdx, so equal is rejected
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Cannot go backward");
    });
  });

  describe("gate check flow", () => {
    it("triggers plan-review gate at planning → implementing", async () => {
      mockShipManager.getShip.mockReturnValue(makeShip({ status: "planning" }));
      const result = await handler.handle("ship-1", {
        request: "status-transition",
        status: "implementing",
      });
      expect(result.ok).toBe(false);
      expect(result.gate).toEqual({
        type: "plan-review",
        from: "planning",
        to: "implementing",
      });
    });

    it("triggers code-review gate at implementing → acceptance-test", async () => {
      mockShipManager.getShip.mockReturnValue(makeShip({ status: "implementing" }));
      const result = await handler.handle("ship-1", {
        request: "status-transition",
        status: "acceptance-test",
      });
      expect(result.ok).toBe(false);
      expect(result.gate).toEqual({
        type: "code-review",
        from: "implementing",
        to: "acceptance-test",
      });
    });

    it("triggers playwright gate at acceptance-test → merging (qaRequired: true)", async () => {
      mockShipManager.getShip.mockReturnValue(
        makeShip({ status: "acceptance-test", qaRequired: true }),
      );
      const result = await handler.handle("ship-1", {
        request: "status-transition",
        status: "merging",
      });
      expect(result.ok).toBe(false);
      expect(result.gate).toEqual({
        type: "playwright",
        from: "acceptance-test",
        to: "merging",
      });
    });

    it("skips playwright gate when qaRequired is false", async () => {
      mockShipManager.getShip.mockReturnValue(
        makeShip({ status: "acceptance-test", qaRequired: false }),
      );
      const result = await handler.handle("ship-1", {
        request: "status-transition",
        status: "merging",
      });
      expect(result.ok).toBe(true);
    });

    it("proceeds after gate approval", async () => {
      mockShipManager.getShip.mockReturnValue(
        makeShip({
          status: "planning",
          gateCheck: {
            transition: "planning→implementing",
            gateType: "plan-review",
            status: "approved",
            requestedAt: new Date().toISOString(),
          },
        }),
      );

      const result = await handler.handle("ship-1", {
        request: "status-transition",
        status: "implementing",
      });
      expect(result.ok).toBe(true);
      expect(mockShipManager.clearGateCheck).toHaveBeenCalledWith("ship-1");
    });

    it("blocks when gate is pending", async () => {
      mockShipManager.getShip.mockReturnValue(
        makeShip({
          status: "planning",
          gateCheck: {
            transition: "planning→implementing",
            gateType: "plan-review",
            status: "pending",
            requestedAt: new Date().toISOString(),
          },
        }),
      );

      const result = await handler.handle("ship-1", {
        request: "status-transition",
        status: "implementing",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Gate check pending");
    });

    it("re-initiates gate after rejection", async () => {
      mockShipManager.getShip.mockReturnValue(
        makeShip({
          status: "planning",
          gateCheck: {
            transition: "planning→implementing",
            gateType: "plan-review",
            status: "rejected",
            feedback: "Missing error handling",
            requestedAt: new Date().toISOString(),
          },
        }),
      );

      const result = await handler.handle("ship-1", {
        request: "status-transition",
        status: "implementing",
      });
      expect(result.ok).toBe(false);
      expect(result.gate).toBeDefined();
      expect(result.gate!.previousFeedback).toBe("Missing error handling");
      expect(mockShipManager.clearGateCheck).toHaveBeenCalledWith("ship-1");
    });
  });

  describe("qaRequired handling", () => {
    it("stores qaRequired when provided with implementing transition", async () => {
      mockShipManager.getShip.mockReturnValue(makeShip({ status: "planning" }));
      await handler.handle(
        "ship-1",
        {
          request: "status-transition",
          status: "implementing",
          qaRequired: false,
        },
        noGates,
      );
      expect(mockShipManager.setQaRequired).toHaveBeenCalledWith("ship-1", false);
    });

    it("does not set qaRequired when not provided", async () => {
      mockShipManager.getShip.mockReturnValue(makeShip({ status: "planning" }));
      await handler.handle(
        "ship-1",
        { request: "status-transition", status: "implementing" },
        noGates,
      );
      expect(mockShipManager.setQaRequired).not.toHaveBeenCalled();
    });
  });

  describe("nothing-to-do request", () => {
    it("marks ship as nothing-to-do and transitions to done", async () => {
      mockShipManager.getShip.mockReturnValue(makeShip({ status: "planning" }));
      const result = await handler.handle("ship-1", {
        request: "nothing-to-do",
        reason: "Issue already resolved",
      });
      expect(result.ok).toBe(true);
      expect(mockShipManager.setNothingToDo).toHaveBeenCalledWith(
        "ship-1",
        "Issue already resolved",
      );
      expect(mockShipManager.updateStatus).toHaveBeenCalledWith("ship-1", "done");
    });
  });

  describe("executeGatedTransition", () => {
    it("completes transition after gate approval", async () => {
      mockShipManager.getShip.mockReturnValue(makeShip({ status: "planning" }));

      const result = await handler.executeGatedTransition("ship-1", "implementing");
      expect(result.ok).toBe(true);
      expect(mockStatusManager.syncPhaseLabel).toHaveBeenCalledWith(
        "owner/repo", 42, "implementing",
      );
      expect(mockShipManager.updateStatus).toHaveBeenCalledWith("ship-1", "implementing");
    });

    it("handles GitHub label sync failure gracefully", async () => {
      mockShipManager.getShip.mockReturnValue(makeShip({ status: "planning" }));
      mockStatusManager.syncPhaseLabel.mockRejectedValue(new Error("GitHub API rate limit"));

      const result = await handler.executeGatedTransition("ship-1", "implementing");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("GitHub label sync failed");
    });
  });

  describe("fleet gate settings override", () => {
    it("disables specific gate via fleet settings", async () => {
      mockShipManager.getShip.mockReturnValue(makeShip({ status: "planning" }));
      const settings: FleetGateSettings = {
        "planning→implementing": false,
      };

      const result = await handler.handle(
        "ship-1",
        { request: "status-transition", status: "implementing" },
        settings,
      );
      expect(result.ok).toBe(true);
    });

    it("overrides gate type via fleet settings", async () => {
      mockShipManager.getShip.mockReturnValue(makeShip({ status: "implementing" }));
      const settings: FleetGateSettings = {
        "implementing→acceptance-test": "playwright",
      };

      const result = await handler.handle(
        "ship-1",
        { request: "status-transition", status: "acceptance-test" },
        settings,
      );
      expect(result.ok).toBe(false);
      expect(result.gate?.type).toBe("playwright");
    });
  });
});
