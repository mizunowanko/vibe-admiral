import { describe, expect, it, vi, beforeEach } from "vitest";
import { ShipRequestHandler } from "../ship-request-handler.js";
import type { FleetDatabase } from "../db.js";
import type { ShipProcess, FleetGateSettings } from "../types.js";

// Minimal mock types
type MockShipManager = {
  getShip: ReturnType<typeof vi.fn>;
  updatePhase: ReturnType<typeof vi.fn>;
  clearGateCheck: ReturnType<typeof vi.fn>;
  setQaRequired: ReturnType<typeof vi.fn>;
};

function makeShip(overrides: Partial<ShipProcess> = {}): ShipProcess {
  return {
    id: "ship-1",
    fleetId: "fleet-1",
    repo: "owner/repo",
    issueNumber: 42,
    issueTitle: "Test",
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

describe("ShipRequestHandler", () => {
  let handler: ShipRequestHandler;
  let mockShipManager: MockShipManager;

  beforeEach(() => {
    mockShipManager = {
      getShip: vi.fn(),
      updatePhase: vi.fn(),
      clearGateCheck: vi.fn(),
      setQaRequired: vi.fn(),
    };
    handler = new ShipRequestHandler(
      mockShipManager as unknown as ConstructorParameters<typeof ShipRequestHandler>[0],
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
      mockShipManager.getShip.mockReturnValue(makeShip({ phase: "merging" }));
      const result = await handler.handle("ship-1", {
        request: "status-transition",
        status: "done",
      });
      expect(result).toEqual({ ok: true });
      expect(mockShipManager.updatePhase).toHaveBeenCalledWith("ship-1", "done");
    });

    it("rejects invalid target phase", async () => {
      mockShipManager.getShip.mockReturnValue(makeShip());
      const result = await handler.handle("ship-1", {
        request: "status-transition",
        // @ts-expect-error — testing invalid input
        status: "invalid-status",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Invalid target phase");
    });

    it("rejects backward transitions", async () => {
      mockShipManager.getShip.mockReturnValue(
        makeShip({ phase: "implementing" }),
      );
      const result = await handler.handle("ship-1", {
        request: "status-transition",
        status: "planning",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Cannot go backward");
    });

    it("allows forward transition without gate (gate disabled)", async () => {
      mockShipManager.getShip.mockReturnValue(
        makeShip({ phase: "planning" }),
      );

      const settings: FleetGateSettings = {
        "planning-gate": false,
      };
      const result = await handler.handle(
        "ship-1",
        { request: "status-transition", status: "implementing" },
        settings,
      );
      expect(result).toEqual({ ok: true });
      expect(mockShipManager.updatePhase).toHaveBeenCalledWith(
        "ship-1",
        "implementing",
      );
    });

    it("returns gate info for gated transitions", async () => {
      mockShipManager.getShip.mockReturnValue(
        makeShip({ phase: "planning" }),
      );

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

    it("proceeds when gate response found in DB (approved)", async () => {
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

      // Mock DB with approved gate-response
      handler.setDatabase({
        getUnreadMessages: vi.fn().mockReturnValue([
          { id: 1, payload: JSON.stringify({ approved: true, gatePhase: "planning-gate" }) },
        ]),
        markMessageRead: vi.fn(),
      } as unknown as FleetDatabase);

      const result = await handler.handle("ship-1", {
        request: "status-transition",
        status: "implementing",
      });
      expect(result).toEqual({ ok: true });
      expect(mockShipManager.clearGateCheck).toHaveBeenCalledWith("ship-1");
    });

    it("returns pending when gate has no response in DB yet", async () => {
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

      // Mock DB with no gate-response
      handler.setDatabase({
        getUnreadMessages: vi.fn().mockReturnValue([]),
        markMessageRead: vi.fn(),
      } as unknown as FleetDatabase);

      const result = await handler.handle("ship-1", {
        request: "status-transition",
        status: "implementing",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Gate check pending");
    });

    it("re-initiates gate check after rejection from DB", async () => {
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

      // Mock DB with rejected gate-response
      handler.setDatabase({
        getUnreadMessages: vi.fn().mockReturnValue([
          { id: 1, payload: JSON.stringify({ approved: false, gatePhase: "planning-gate" }) },
        ]),
        markMessageRead: vi.fn(),
      } as unknown as FleetDatabase);

      const result = await handler.handle("ship-1", {
        request: "status-transition",
        status: "implementing",
      });
      expect(result.ok).toBe(false);
      expect(result.gate).toEqual({
        type: "plan-review",
        gatePhase: "planning-gate",
        targetPhase: "implementing",
        previousFeedback: undefined,
      });
      expect(mockShipManager.clearGateCheck).toHaveBeenCalledWith("ship-1");
    });

    it("passes previous feedback when re-initiating after rejection", async () => {
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

      // Mock DB with rejected gate-response that includes feedback
      handler.setDatabase({
        getUnreadMessages: vi.fn().mockReturnValue([
          { id: 1, payload: JSON.stringify({ approved: false, gatePhase: "planning-gate", feedback: "Plan is missing test strategy" }) },
        ]),
        markMessageRead: vi.fn(),
      } as unknown as FleetDatabase);

      const result = await handler.handle("ship-1", {
        request: "status-transition",
        status: "implementing",
      });
      expect(result.ok).toBe(false);
      expect(result.gate).toEqual({
        type: "plan-review",
        gatePhase: "planning-gate",
        targetPhase: "implementing",
        previousFeedback: "Plan is missing test strategy",
      });
    });

    it("respects fleet gate settings (disabled gate)", async () => {
      mockShipManager.getShip.mockReturnValue(
        makeShip({ phase: "planning" }),
      );

      const settings: FleetGateSettings = {
        "planning-gate": false,
      };
      const result = await handler.handle(
        "ship-1",
        { request: "status-transition", status: "implementing" },
        settings,
      );
      expect(result).toEqual({ ok: true });
    });

    it("skips playwright gate when qaRequired is false", async () => {
      mockShipManager.getShip.mockReturnValue(
        makeShip({ phase: "acceptance-test", qaRequired: false }),
      );

      const result = await handler.handle("ship-1", {
        request: "status-transition",
        status: "merging",
      });
      // Should proceed without gate because qaRequired is false
      expect(result).toEqual({ ok: true });
      expect(mockShipManager.updatePhase).toHaveBeenCalledWith(
        "ship-1",
        "merging",
      );
    });

    it("triggers playwright gate when qaRequired is true", async () => {
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

    it("triggers playwright gate when qaRequired is not set (defaults to true)", async () => {
      mockShipManager.getShip.mockReturnValue(
        makeShip({ phase: "acceptance-test" }),
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

    it("stores qaRequired when transitioning to implementing", async () => {
      mockShipManager.getShip.mockReturnValue(
        makeShip({ phase: "planning" }),
      );

      await handler.handle("ship-1", {
        request: "status-transition",
        status: "implementing",
        qaRequired: false,
      });
      expect(mockShipManager.setQaRequired).toHaveBeenCalledWith("ship-1", false);
    });

    it("does not call setQaRequired when qaRequired is not provided", async () => {
      mockShipManager.getShip.mockReturnValue(
        makeShip({ phase: "planning" }),
      );

      await handler.handle("ship-1", {
        request: "status-transition",
        status: "implementing",
      });
      expect(mockShipManager.setQaRequired).not.toHaveBeenCalled();
    });

    it("advances phase when gate disabled and updates ship manager", async () => {
      mockShipManager.getShip.mockReturnValue(
        makeShip({ phase: "planning" }),
      );

      const settings: FleetGateSettings = {
        "planning-gate": false,
      };
      const result = await handler.handle(
        "ship-1",
        { request: "status-transition", status: "implementing" },
        settings,
      );
      expect(result).toEqual({ ok: true });
      expect(mockShipManager.updatePhase).toHaveBeenCalledWith("ship-1", "implementing");
    });
  });

});
