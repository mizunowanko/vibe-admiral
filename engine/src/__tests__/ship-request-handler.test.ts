import { describe, expect, it, vi, beforeEach } from "vitest";
import { ShipRequestHandler } from "../ship-request-handler.js";
import type { ShipProcess, FleetGateSettings } from "../types.js";

// Minimal mock types
type MockShipManager = {
  getShip: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
  clearGateCheck: ReturnType<typeof vi.fn>;
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
    issueTitle: "Test",
    status: "investigating",
    isCompacting: false,
    branchName: "feature/42-test",
    worktreePath: "/tmp/worktree",
    sessionId: null,
    prUrl: null,
    prReviewStatus: null,
    acceptanceTest: null,
    acceptanceTestApproved: false,
    gateCheck: null,
    errorType: null,
    retryCount: 0,
    createdAt: new Date().toISOString(),
    lastOutputAt: null,
    ...overrides,
  };
}

describe("ShipRequestHandler", () => {
  let handler: ShipRequestHandler;
  let mockShipManager: MockShipManager;
  let mockStatusManager: MockStatusManager;

  beforeEach(() => {
    mockShipManager = {
      getShip: vi.fn(),
      updateStatus: vi.fn(),
      clearGateCheck: vi.fn(),
    };
    mockStatusManager = {
      syncPhaseLabel: vi.fn(),
    };
    handler = new ShipRequestHandler(
      mockShipManager as unknown as ConstructorParameters<typeof ShipRequestHandler>[0],
      mockStatusManager as unknown as ConstructorParameters<typeof ShipRequestHandler>[1],
    );
  });

  describe("handle (status-transition)", () => {
    it("returns error when ship not found", async () => {
      mockShipManager.getShip.mockReturnValue(undefined);
      const result = await handler.handle("unknown", {
        request: "status-transition",
        status: "planning",
      });
      expect(result).toEqual({
        ok: false,
        error: "Ship unknown not found",
      });
    });

    it("handles 'done' as a terminal state", async () => {
      mockShipManager.getShip.mockReturnValue(makeShip({ status: "merging" }));
      const result = await handler.handle("ship-1", {
        request: "status-transition",
        status: "done",
      });
      expect(result).toEqual({ ok: true });
      expect(mockShipManager.updateStatus).toHaveBeenCalledWith("ship-1", "done");
      expect(mockStatusManager.syncPhaseLabel).not.toHaveBeenCalled();
    });

    it("rejects invalid target status", async () => {
      mockShipManager.getShip.mockReturnValue(makeShip());
      const result = await handler.handle("ship-1", {
        request: "status-transition",
        // @ts-expect-error — testing invalid input
        status: "invalid-status",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Invalid target status");
    });

    it("rejects backward transitions", async () => {
      mockShipManager.getShip.mockReturnValue(
        makeShip({ status: "implementing" }),
      );
      const result = await handler.handle("ship-1", {
        request: "status-transition",
        status: "planning",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Cannot go backward");
    });

    it("allows forward transition without gate", async () => {
      mockShipManager.getShip.mockReturnValue(
        makeShip({ status: "investigating" }),
      );
      mockStatusManager.syncPhaseLabel.mockResolvedValue(undefined);

      const result = await handler.handle("ship-1", {
        request: "status-transition",
        status: "planning",
      });
      expect(result).toEqual({ ok: true });
      expect(mockStatusManager.syncPhaseLabel).toHaveBeenCalledWith(
        "owner/repo",
        42,
        "planning",
      );
      expect(mockShipManager.updateStatus).toHaveBeenCalledWith(
        "ship-1",
        "planning",
      );
    });

    it("returns gate info for gated transitions", async () => {
      mockShipManager.getShip.mockReturnValue(
        makeShip({ status: "planning" }),
      );

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

    it("proceeds when gate was already approved", async () => {
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
      mockStatusManager.syncPhaseLabel.mockResolvedValue(undefined);

      const result = await handler.handle("ship-1", {
        request: "status-transition",
        status: "implementing",
      });
      expect(result).toEqual({ ok: true });
      expect(mockShipManager.clearGateCheck).toHaveBeenCalledWith("ship-1");
    });

    it("rejects when gate is still pending", async () => {
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

    it("re-initiates gate check after rejection", async () => {
      mockShipManager.getShip.mockReturnValue(
        makeShip({
          status: "planning",
          gateCheck: {
            transition: "planning→implementing",
            gateType: "plan-review",
            status: "rejected",
            requestedAt: new Date().toISOString(),
          },
        }),
      );

      const result = await handler.handle("ship-1", {
        request: "status-transition",
        status: "implementing",
      });
      expect(result.ok).toBe(false);
      expect(result.gate).toEqual({
        type: "plan-review",
        from: "planning",
        to: "implementing",
        previousFeedback: undefined,
      });
      expect(mockShipManager.clearGateCheck).toHaveBeenCalledWith("ship-1");
    });

    it("passes previous feedback when re-initiating after rejection", async () => {
      mockShipManager.getShip.mockReturnValue(
        makeShip({
          status: "planning",
          gateCheck: {
            transition: "planning→implementing",
            gateType: "plan-review",
            status: "rejected",
            feedback: "Plan is missing test strategy",
            requestedAt: new Date().toISOString(),
          },
        }),
      );

      const result = await handler.handle("ship-1", {
        request: "status-transition",
        status: "implementing",
      });
      expect(result.ok).toBe(false);
      expect(result.gate).toEqual({
        type: "plan-review",
        from: "planning",
        to: "implementing",
        previousFeedback: "Plan is missing test strategy",
      });
    });

    it("respects fleet gate settings (disabled gate)", async () => {
      mockShipManager.getShip.mockReturnValue(
        makeShip({ status: "planning" }),
      );
      mockStatusManager.syncPhaseLabel.mockResolvedValue(undefined);

      const settings: FleetGateSettings = {
        "planning→implementing": false,
      };
      const result = await handler.handle(
        "ship-1",
        { request: "status-transition", status: "implementing" },
        settings,
      );
      expect(result).toEqual({ ok: true });
    });

    it("returns error when GitHub label sync fails", async () => {
      mockShipManager.getShip.mockReturnValue(
        makeShip({ status: "investigating" }),
      );
      mockStatusManager.syncPhaseLabel.mockRejectedValue(
        new Error("GitHub API error"),
      );

      const result = await handler.handle("ship-1", {
        request: "status-transition",
        status: "planning",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("GitHub label sync failed");
    });
  });

  describe("executeGatedTransition", () => {
    it("syncs label and updates status on success", async () => {
      mockShipManager.getShip.mockReturnValue(
        makeShip({ status: "planning" }),
      );
      mockStatusManager.syncPhaseLabel.mockResolvedValue(undefined);

      const result = await handler.executeGatedTransition(
        "ship-1",
        "implementing",
      );
      expect(result).toEqual({ ok: true });
      expect(mockStatusManager.syncPhaseLabel).toHaveBeenCalledWith(
        "owner/repo",
        42,
        "implementing",
      );
      expect(mockShipManager.updateStatus).toHaveBeenCalledWith(
        "ship-1",
        "implementing",
      );
    });

    it("returns error when ship not found", async () => {
      mockShipManager.getShip.mockReturnValue(undefined);
      const result = await handler.executeGatedTransition(
        "unknown",
        "implementing",
      );
      expect(result.ok).toBe(false);
    });

    it("returns error when label sync fails", async () => {
      mockShipManager.getShip.mockReturnValue(
        makeShip({ status: "planning" }),
      );
      mockStatusManager.syncPhaseLabel.mockRejectedValue(
        new Error("API error"),
      );
      const result = await handler.executeGatedTransition(
        "ship-1",
        "implementing",
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("GitHub label sync failed");
    });
  });
});
