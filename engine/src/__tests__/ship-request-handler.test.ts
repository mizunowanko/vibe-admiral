import { describe, expect, it, vi, beforeEach } from "vitest";
import { ShipRequestHandler } from "../ship-request-handler.js";
import type { ShipProcess } from "../types.js";

// Minimal mock types
type MockShipManager = {
  getShip: ReturnType<typeof vi.fn>;
  updatePhase: ReturnType<typeof vi.fn>;
  setNothingToDo: ReturnType<typeof vi.fn>;
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

// Mock github module
vi.mock("../github.js", () => ({
  commentOnIssue: vi.fn().mockResolvedValue(undefined),
  closeIssue: vi.fn().mockResolvedValue(undefined),
}));

describe("ShipRequestHandler", () => {
  let handler: ShipRequestHandler;
  let mockShipManager: MockShipManager;

  beforeEach(() => {
    mockShipManager = {
      getShip: vi.fn(),
      updatePhase: vi.fn(),
      setNothingToDo: vi.fn(),
    };
    handler = new ShipRequestHandler(
      mockShipManager as unknown as ConstructorParameters<typeof ShipRequestHandler>[0],
    );
  });

  describe("handle (nothing-to-do)", () => {
    it("returns error when ship not found", async () => {
      mockShipManager.getShip.mockReturnValue(undefined);
      const result = await handler.handle("unknown", {
        request: "nothing-to-do",
        reason: "Already resolved",
      });
      expect(result).toEqual({
        ok: false,
        error: "Ship unknown not found",
      });
    });

    it("marks ship as done with nothingToDo flag", async () => {
      mockShipManager.getShip.mockReturnValue(makeShip());
      const result = await handler.handle("ship-1", {
        request: "nothing-to-do",
        reason: "Already resolved",
      });
      expect(result).toEqual({ ok: true });
      expect(mockShipManager.setNothingToDo).toHaveBeenCalledWith("ship-1", "Already resolved");
      expect(mockShipManager.updatePhase).toHaveBeenCalledWith("ship-1", "done");
    });
  });

});
