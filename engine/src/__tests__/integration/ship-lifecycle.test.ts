import { describe, expect, it, vi, beforeEach } from "vitest";
import { ShipRequestHandler } from "../../ship-request-handler.js";
import type { ShipProcess, FleetGateSettings, Phase } from "../../types.js";

/**
 * Integration test: Ship lifecycle state machine
 *
 * Tests the full Ship phase progression:
 *   planning → implementing → acceptance-test → merging → done
 *
 * Includes gate check flow, backward transition rejection,
 * and the interplay between ShipRequestHandler and ShipManager.
 */

type MockShipManager = {
  getShip: ReturnType<typeof vi.fn>;
  updatePhase: ReturnType<typeof vi.fn>;
  clearGateCheck: ReturnType<typeof vi.fn>;
  setQaRequired: ReturnType<typeof vi.fn>;
  setNothingToDo: ReturnType<typeof vi.fn>;
};

function makeShip(overrides: Partial<ShipProcess> = {}): ShipProcess {
  return {
    id: "ship-1",
    fleetId: "fleet-1",
    repo: "owner/repo",
    issueNumber: 42,
    issueTitle: "Test feature",
    phase: "planning",
    isCompacting: false,
    branchName: "feature/42-test",
    worktreePath: "/tmp/worktree",
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

describe("Ship lifecycle (integration)", () => {
  let handler: ShipRequestHandler;
  let mockShipManager: MockShipManager;

  // All gates disabled for lifecycle flow tests (gates tested separately)
  const noGates: FleetGateSettings = {
    "planning-gate": false,
    "implementing-gate": false,
    "acceptance-test-gate": false,
  };

  beforeEach(() => {
    mockShipManager = {
      getShip: vi.fn(),
      updatePhase: vi.fn(),
      clearGateCheck: vi.fn(),
      setQaRequired: vi.fn(),
      setNothingToDo: vi.fn(),
    };
    handler = new ShipRequestHandler(
      mockShipManager as unknown as ConstructorParameters<typeof ShipRequestHandler>[0],
    );
  });

  describe("full forward progression (gates disabled)", () => {
    it("transitions planning → implementing → acceptance-test → merging → done", async () => {
      const transitions: Array<{ from: Phase; to: Phase }> = [
        { from: "planning", to: "implementing" },
        { from: "implementing", to: "acceptance-test" },
        { from: "acceptance-test", to: "merging" },
      ];

      for (const { from, to } of transitions) {
        mockShipManager.getShip.mockReturnValue(makeShip({ phase: from }));
        const result = await handler.handle(
          "ship-1",
          { request: "status-transition", status: to },
          noGates,
        );
        expect(result.ok).toBe(true);
        expect(mockShipManager.updatePhase).toHaveBeenCalledWith("ship-1", to);
      }

      // done is terminal — no label sync
      mockShipManager.getShip.mockReturnValue(makeShip({ phase: "merging" }));
      const doneResult = await handler.handle(
        "ship-1",
        { request: "status-transition", status: "done" },
        noGates,
      );
      expect(doneResult.ok).toBe(true);
      expect(mockShipManager.updatePhase).toHaveBeenCalledWith("ship-1", "done");
    });
  });

  describe("backward transitions", () => {
    it("rejects backward transitions between phase statuses", async () => {
      const backward: Array<{ from: Phase; to: Phase }> = [
        { from: "implementing", to: "planning" },
        { from: "acceptance-test", to: "implementing" },
        { from: "merging", to: "acceptance-test" },
      ];

      for (const { from, to } of backward) {
        mockShipManager.getShip.mockReturnValue(makeShip({ phase: from }));
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
      mockShipManager.getShip.mockReturnValue(makeShip({ phase: "implementing" }));
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
      mockShipManager.getShip.mockReturnValue(makeShip({ phase: "planning" }));
      const result = await handler.handle("ship-1", {
        request: "status-transition",
        status: "implementing",
      });
      expect(result.ok).toBe(false);
      expect(result.gate).toEqual({
        type: "plan-review",
        gatePhase: "planning-gate",
        targetPhase: "implementing",
      });
    });

    it("triggers code-review gate at implementing → acceptance-test", async () => {
      mockShipManager.getShip.mockReturnValue(makeShip({ phase: "implementing" }));
      const result = await handler.handle("ship-1", {
        request: "status-transition",
        status: "acceptance-test",
      });
      expect(result.ok).toBe(false);
      expect(result.gate).toEqual({
        type: "code-review",
        gatePhase: "implementing-gate",
        targetPhase: "acceptance-test",
      });
    });

    it("triggers playwright gate at acceptance-test → merging (qaRequired: true)", async () => {
      mockShipManager.getShip.mockReturnValue(
        makeShip({ phase: "acceptance-test", qaRequired: true }),
      );
      const result = await handler.handle("ship-1", {
        request: "status-transition",
        status: "merging",
      });
      expect(result.ok).toBe(false);
      expect(result.gate).toEqual({
        type: "playwright",
        gatePhase: "acceptance-test-gate",
        targetPhase: "merging",
      });
    });

    it("skips playwright gate when qaRequired is false", async () => {
      mockShipManager.getShip.mockReturnValue(
        makeShip({ phase: "acceptance-test", qaRequired: false }),
      );
      const result = await handler.handle("ship-1", {
        request: "status-transition",
        status: "merging",
      });
      expect(result.ok).toBe(true);
    });

    it("proceeds after gate approval (via DB gate-response)", async () => {
      mockShipManager.getShip.mockReturnValue(
        makeShip({
          phase: "planning",
          gateCheck: {
            gatePhase: "planning-gate",
            gateType: "plan-review",
            status: "pending",
            requestedAt: new Date().toISOString(),
          },
        }),
      );

      // Mock DB returns an approved gate-response
      const mockDb = {
        getUnreadMessages: vi.fn().mockReturnValue([{
          id: 1,
          ship_id: "ship-1",
          type: "gate-response",
          sender: "escort",
          payload: JSON.stringify({ approved: true }),
          read_at: null,
          created_at: new Date().toISOString(),
        }]),
        markMessageRead: vi.fn(),
      };
      handler.setDatabase(mockDb as unknown as Parameters<typeof handler.setDatabase>[0]);

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
          phase: "planning",
          gateCheck: {
            gatePhase: "planning-gate",
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

    it("re-initiates gate after rejection (via DB gate-response)", async () => {
      mockShipManager.getShip.mockReturnValue(
        makeShip({
          phase: "planning",
          gateCheck: {
            gatePhase: "planning-gate",
            gateType: "plan-review",
            status: "pending",
            requestedAt: new Date().toISOString(),
          },
        }),
      );

      // Mock DB returns a rejected gate-response with feedback
      const mockDb = {
        getUnreadMessages: vi.fn().mockReturnValue([{
          id: 2,
          ship_id: "ship-1",
          type: "gate-response",
          sender: "escort",
          payload: JSON.stringify({ approved: false, feedback: "Missing error handling" }),
          read_at: null,
          created_at: new Date().toISOString(),
        }]),
        markMessageRead: vi.fn(),
      };
      handler.setDatabase(mockDb as unknown as Parameters<typeof handler.setDatabase>[0]);

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
      mockShipManager.getShip.mockReturnValue(makeShip({ phase: "planning" }));
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
      mockShipManager.getShip.mockReturnValue(makeShip({ phase: "planning" }));
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
      mockShipManager.getShip.mockReturnValue(makeShip({ phase: "planning" }));
      const result = await handler.handle("ship-1", {
        request: "nothing-to-do",
        reason: "Issue already resolved",
      });
      expect(result.ok).toBe(true);
      expect(mockShipManager.setNothingToDo).toHaveBeenCalledWith(
        "ship-1",
        "Issue already resolved",
      );
      expect(mockShipManager.updatePhase).toHaveBeenCalledWith("ship-1", "done");
    });
  });

  describe("fleet gate settings override", () => {
    it("disables specific gate via fleet settings", async () => {
      mockShipManager.getShip.mockReturnValue(makeShip({ phase: "planning" }));
      const settings: FleetGateSettings = {
        "planning-gate": false,
      };

      const result = await handler.handle(
        "ship-1",
        { request: "status-transition", status: "implementing" },
        settings,
      );
      expect(result.ok).toBe(true);
    });

    it("overrides gate type via fleet settings", async () => {
      mockShipManager.getShip.mockReturnValue(makeShip({ phase: "implementing" }));
      const settings: FleetGateSettings = {
        "implementing-gate": "playwright",
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
