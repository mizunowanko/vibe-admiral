import { describe, expect, it, vi, beforeEach } from "vitest";
import { ShipRequestHandler } from "../../ship-request-handler.js";
import type { ShipProcess } from "../../types.js";

/**
 * Integration test: Ship lifecycle — nothing-to-do flow
 *
 * Note: status-transition tests were removed in #439.
 * Ships now update the phases table directly via sqlite3 CLI,
 * bypassing the ShipRequestHandler entirely for phase transitions.
 */

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

// Mock github module
vi.mock("../../github.js", () => ({
  commentOnIssue: vi.fn().mockResolvedValue(undefined),
  closeIssue: vi.fn().mockResolvedValue(undefined),
}));

describe("Ship lifecycle (integration)", () => {
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

    it("returns error when ship not found", async () => {
      mockShipManager.getShip.mockReturnValue(undefined);
      const result = await handler.handle("unknown", {
        request: "nothing-to-do",
        reason: "Issue already resolved",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Ship unknown not found");
    });
  });
});
