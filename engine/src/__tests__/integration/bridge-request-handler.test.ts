import { describe, expect, it, vi, beforeEach } from "vitest";
import { FlagshipRequestHandler } from "../../bridge-request-handler.js";
import type { ShipProcess, FleetRepo, FlagshipRequest } from "../../types.js";

// === Mock types (real classes wired together, only I/O mocked) ===

type MockShipManager = {
  getShip: ReturnType<typeof vi.fn>;
  getShipsByFleet: ReturnType<typeof vi.fn>;
  getAllShips: ReturnType<typeof vi.fn>;
  resolveShip: ReturnType<typeof vi.fn>;
  sortie: ReturnType<typeof vi.fn>;
  stopShip: ReturnType<typeof vi.fn>;
  retryShip: ReturnType<typeof vi.fn>;
  updatePhase: ReturnType<typeof vi.fn>;
  clearGateCheck: ReturnType<typeof vi.fn>;
  setQaRequired: ReturnType<typeof vi.fn>;
  setGateCheck: ReturnType<typeof vi.fn>;
  setNothingToDo: ReturnType<typeof vi.fn>;
  respondToGate: ReturnType<typeof vi.fn>;
  respondToPRReview: ReturnType<typeof vi.fn>;
};

type MockStateSync = {
  sortieGuard: ReturnType<typeof vi.fn>;
};

function makeShip(overrides: Partial<ShipProcess> = {}): ShipProcess {
  return {
    id: "ship-aaa-111",
    fleetId: "fleet-1",
    repo: "owner/repo",
    issueNumber: 42,
    issueTitle: "Test feature",
    phase: "planning",
    isCompacting: false,
    branchName: "feature/42-test-feature",
    worktreePath: "/tmp/worktrees/42",
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

describe("FlagshipRequestHandler (integration)", () => {
  let handler: FlagshipRequestHandler;
  let mockShipManager: MockShipManager;
  let mockStateSync: MockStateSync;

  const fleetRepos: FleetRepo[] = [
    { localPath: "/home/user/repo", remote: "owner/repo" },
  ];
  const repoRemotes = ["owner/repo"];

  beforeEach(() => {
    mockShipManager = {
      getShip: vi.fn(),
      getShipsByFleet: vi.fn().mockReturnValue([]),
      getAllShips: vi.fn().mockReturnValue([]),
      resolveShip: vi.fn(),
      sortie: vi.fn(),
      stopShip: vi.fn(),
      retryShip: vi.fn(),
      updatePhase: vi.fn(),
      clearGateCheck: vi.fn(),
      setQaRequired: vi.fn(),
      setGateCheck: vi.fn(),
      setNothingToDo: vi.fn(),
      respondToGate: vi.fn(),
      respondToPRReview: vi.fn(),
    };
    mockStateSync = {
      sortieGuard: vi.fn().mockResolvedValue({ ok: true }),
    };

    // Wire real handler classes together (integration point)
    handler = new FlagshipRequestHandler(
      mockShipManager as unknown as ConstructorParameters<typeof FlagshipRequestHandler>[0],
      mockStateSync as unknown as ConstructorParameters<typeof FlagshipRequestHandler>[1],
    );
  });

  describe("sortie flow", () => {
    it("launches a Ship when sortie guard passes and repo is valid", async () => {
      const ship = makeShip();
      mockShipManager.sortie.mockResolvedValue(ship);

      const request: FlagshipRequest = {
        request: "sortie",
        items: [{ repo: "owner/repo", issueNumber: 42 }],
      };
      const result = await handler.handle("fleet-1", request, fleetRepos, repoRemotes);

      expect(result).toContain("Ship ship-aaa-111 launched");
      expect(mockStateSync.sortieGuard).toHaveBeenCalledWith("owner/repo", 42);
      expect(mockShipManager.sortie).toHaveBeenCalledWith(
        "fleet-1", "owner/repo", 42, "/home/user/repo",
        undefined, undefined, undefined,
      );
    });

    it("rejects sortie when repo is not in fleet", async () => {
      const request: FlagshipRequest = {
        request: "sortie",
        items: [{ repo: "other/repo", issueNumber: 99 }],
      };
      const result = await handler.handle("fleet-1", request, fleetRepos, repoRemotes);
      expect(result).toContain("Rejected other/repo#99: repo not registered");
    });

    it("blocks sortie when guard check fails", async () => {
      mockStateSync.sortieGuard.mockResolvedValue({
        ok: false,
        reason: "Ship already active for this issue",
      });

      const request: FlagshipRequest = {
        request: "sortie",
        items: [{ repo: "owner/repo", issueNumber: 42 }],
      };
      const result = await handler.handle("fleet-1", request, fleetRepos, repoRemotes);
      expect(result).toContain("Blocked owner/repo#42");
      expect(result).toContain("Ship already active");
      expect(mockShipManager.sortie).not.toHaveBeenCalled();
    });

    it("throttles when concurrent limit is reached", async () => {
      const activeShips = [
        makeShip({ id: "s1", phase: "planning" }),
        makeShip({ id: "s2", phase: "implementing" }),
      ];
      mockShipManager.getShipsByFleet.mockReturnValue(activeShips);

      const request: FlagshipRequest = {
        request: "sortie",
        items: [{ repo: "owner/repo", issueNumber: 42 }],
      };
      const result = await handler.handle(
        "fleet-1", request, fleetRepos, repoRemotes,
        undefined, undefined, 2, // maxConcurrentSorties = 2
      );
      expect(result).toContain("Sortie Throttled");
    });

    it("handles multiple sortie items with partial success", async () => {
      const ship = makeShip();
      mockShipManager.sortie.mockResolvedValue(ship);
      mockStateSync.sortieGuard
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: false, reason: "Blocked by dependency" });

      const repos: FleetRepo[] = [
        { localPath: "/home/user/repo", remote: "owner/repo" },
        { localPath: "/home/user/repo2", remote: "owner/repo2" },
      ];
      const request: FlagshipRequest = {
        request: "sortie",
        items: [
          { repo: "owner/repo", issueNumber: 42 },
          { repo: "owner/repo2", issueNumber: 43 },
        ],
      };
      const result = await handler.handle(
        "fleet-1", request, repos, ["owner/repo", "owner/repo2"],
      );
      expect(result).toContain("launched");
      expect(result).toContain("Blocked owner/repo2#43");
    });
  });

  describe("ship-status", () => {
    it("returns status for all ships in fleet", async () => {
      mockShipManager.getShipsByFleet.mockReturnValue([
        makeShip({ id: "s1", issueNumber: 10, phase: "planning" }),
        makeShip({ id: "s2", issueNumber: 11, phase: "implementing" }),
      ]);

      const result = await handler.handle(
        "fleet-1",
        { request: "ship-status" },
        fleetRepos, repoRemotes,
      );
      expect(result).toContain("Ship s1 #10");
      expect(result).toContain("Ship s2 #11");
    });

    it("returns empty message when no ships exist", async () => {
      mockShipManager.getShipsByFleet.mockReturnValue([]);
      const result = await handler.handle(
        "fleet-1",
        { request: "ship-status" },
        fleetRepos, repoRemotes,
      );
      expect(result).toContain("No active ships");
    });
  });

  describe("ship-stop", () => {
    it("stops a running ship", async () => {
      const ship = makeShip();
      mockShipManager.resolveShip.mockReturnValue(ship);
      mockShipManager.stopShip.mockReturnValue(true);

      const result = await handler.handle(
        "fleet-1",
        { request: "ship-stop", shipId: "ship-aaa-111" },
        fleetRepos, repoRemotes,
      );
      expect(result).toContain("Ship Stopped");
    });

    it("returns error when ship not found", async () => {
      mockShipManager.resolveShip.mockReturnValue(undefined);
      const result = await handler.handle(
        "fleet-1",
        { request: "ship-stop", shipId: "nonexistent" },
        fleetRepos, repoRemotes,
      );
      expect(result).toContain("not found");
    });
  });

  describe("ship-resume", () => {
    it("resumes a dead ship with session", async () => {
      const ship = makeShip({ phase: "implementing", sessionId: "sess-123" });
      mockShipManager.resolveShip.mockReturnValue(ship);
      mockShipManager.retryShip.mockReturnValue(ship);

      const result = await handler.handle(
        "fleet-1",
        { request: "ship-resume", shipId: "ship-aaa-111" },
        fleetRepos, repoRemotes,
      );
      expect(result).toContain("Resumed");
      expect(result).toContain("session resume");
    });

    it("rejects resume for done ship", async () => {
      const ship = makeShip({ phase: "done" });
      mockShipManager.resolveShip.mockReturnValue(ship);

      const result = await handler.handle(
        "fleet-1",
        { request: "ship-resume", shipId: "ship-aaa-111" },
        fleetRepos, repoRemotes,
      );
      expect(result).toContain("already done");
    });
  });
});
