import { describe, expect, it, vi, beforeEach } from "vitest";
import { BridgeRequestHandler } from "../../bridge-request-handler.js";
import { ShipRequestHandler } from "../../ship-request-handler.js";
import type { ShipProcess, FleetRepo, BridgeRequest, GateTransition } from "../../types.js";

// === Mock types (real classes wired together, only I/O mocked) ===

type MockShipManager = {
  getShip: ReturnType<typeof vi.fn>;
  getShipsByFleet: ReturnType<typeof vi.fn>;
  getAllShips: ReturnType<typeof vi.fn>;
  resolveShip: ReturnType<typeof vi.fn>;
  sortie: ReturnType<typeof vi.fn>;
  stopShip: ReturnType<typeof vi.fn>;
  retryShip: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
  clearGateCheck: ReturnType<typeof vi.fn>;
  setQaRequired: ReturnType<typeof vi.fn>;
  setGateCheck: ReturnType<typeof vi.fn>;
  setEscortAgentId: ReturnType<typeof vi.fn>;
  respondToGate: ReturnType<typeof vi.fn>;
  respondToPRReview: ReturnType<typeof vi.fn>;
};

type MockStatusManager = {
  syncPhaseLabel: ReturnType<typeof vi.fn>;
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
    status: "planning",
    isCompacting: false,
    branchName: "feature/42-test-feature",
    worktreePath: "/tmp/worktrees/42",
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

describe("BridgeRequestHandler (integration)", () => {
  let handler: BridgeRequestHandler;
  let shipRequestHandler: ShipRequestHandler;
  let mockShipManager: MockShipManager;
  let mockStatusManager: MockStatusManager;
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
      updateStatus: vi.fn(),
      clearGateCheck: vi.fn(),
      setQaRequired: vi.fn(),
      setGateCheck: vi.fn(),
      setEscortAgentId: vi.fn(),
      respondToGate: vi.fn(),
      respondToPRReview: vi.fn(),
    };
    mockStatusManager = {
      syncPhaseLabel: vi.fn().mockResolvedValue(undefined),
    };
    mockStateSync = {
      sortieGuard: vi.fn().mockResolvedValue({ ok: true }),
    };

    // Wire real handler classes together (integration point)
    handler = new BridgeRequestHandler(
      mockShipManager as unknown as ConstructorParameters<typeof BridgeRequestHandler>[0],
      mockStateSync as unknown as ConstructorParameters<typeof BridgeRequestHandler>[1],
    );
    shipRequestHandler = new ShipRequestHandler(
      mockShipManager as unknown as ConstructorParameters<typeof ShipRequestHandler>[0],
      mockStatusManager as unknown as ConstructorParameters<typeof ShipRequestHandler>[1],
    );
    handler.setShipRequestHandler(shipRequestHandler);
  });

  describe("sortie flow", () => {
    it("launches a Ship when sortie guard passes and repo is valid", async () => {
      const ship = makeShip();
      mockShipManager.sortie.mockResolvedValue(ship);

      const request: BridgeRequest = {
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
      const request: BridgeRequest = {
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

      const request: BridgeRequest = {
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
        makeShip({ id: "s1", status: "planning" }),
        makeShip({ id: "s2", status: "implementing" }),
      ];
      mockShipManager.getShipsByFleet.mockReturnValue(activeShips);

      const request: BridgeRequest = {
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
      const request: BridgeRequest = {
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
        makeShip({ id: "s1", issueNumber: 10, status: "planning" }),
        makeShip({ id: "s2", issueNumber: 11, status: "implementing" }),
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
    it("resumes an errored ship with session", async () => {
      const ship = makeShip({ status: "error", sessionId: "sess-123" });
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

    it("rejects resume for non-error ship", async () => {
      const ship = makeShip({ status: "implementing" });
      mockShipManager.resolveShip.mockReturnValue(ship);

      const result = await handler.handle(
        "fleet-1",
        { request: "ship-resume", shipId: "ship-aaa-111" },
        fleetRepos, repoRemotes,
      );
      expect(result).toContain("not in error state");
    });
  });

  describe("gate-ack", () => {
    it("acknowledges a pending gate check", async () => {
      const ship = makeShip({
        gateCheck: {
          transition: "planning→implementing",
          gateType: "plan-review",
          status: "pending",
          requestedAt: new Date().toISOString(),
        },
      });
      mockShipManager.resolveShip.mockReturnValue(ship);

      const result = await handler.handle(
        "fleet-1",
        {
          request: "gate-ack",
          shipId: "ship-aaa-111",
          transition: "planning→implementing" as GateTransition,
        },
        fleetRepos, repoRemotes,
      );
      expect(result).toContain("Gate ACK");
      expect(ship.gateCheck!.acknowledgedAt).toBeDefined();
    });

    it("rejects ack for non-pending gate", async () => {
      const ship = makeShip({
        gateCheck: {
          transition: "planning→implementing",
          gateType: "plan-review",
          status: "approved",
          requestedAt: new Date().toISOString(),
        },
      });
      mockShipManager.resolveShip.mockReturnValue(ship);

      const result = await handler.handle(
        "fleet-1",
        {
          request: "gate-ack",
          shipId: "ship-aaa-111",
          transition: "planning→implementing" as GateTransition,
        },
        fleetRepos, repoRemotes,
      );
      expect(result).toContain("already approved");
    });
  });

  describe("gate-result → gated transition (cross-handler)", () => {
    let gateApprovedSpy: ReturnType<typeof vi.fn<(shipId: string, transition: GateTransition) => void>>;
    let gateRejectedSpy: ReturnType<typeof vi.fn<(shipId: string, transition: GateTransition, feedback?: string) => void>>;

    beforeEach(() => {
      gateApprovedSpy = vi.fn<(shipId: string, transition: GateTransition) => void>();
      gateRejectedSpy = vi.fn<(shipId: string, transition: GateTransition, feedback?: string) => void>();
      handler.setGateApprovedHandler(gateApprovedSpy);
      handler.setGateRejectedHandler(gateRejectedSpy);
    });

    it("approves gate and executes gated transition via ShipRequestHandler", async () => {
      const ship = makeShip({
        status: "planning",
        gateCheck: {
          transition: "planning→implementing",
          gateType: "plan-review",
          status: "pending",
          requestedAt: new Date().toISOString(),
        },
      });
      mockShipManager.resolveShip.mockReturnValue(ship);
      mockShipManager.getShip.mockReturnValue(ship);
      mockShipManager.respondToGate.mockResolvedValue(undefined);

      const result = await handler.handle(
        "fleet-1",
        {
          request: "gate-result",
          shipId: "ship-aaa-111",
          transition: "planning→implementing" as GateTransition,
          verdict: "approve",
        },
        fleetRepos, repoRemotes,
      );

      expect(result).toContain("Gate Approved");
      expect(result).toContain("transition confirmed");
      expect(mockShipManager.respondToGate).toHaveBeenCalledWith("ship-aaa-111", true, undefined);
      expect(mockStatusManager.syncPhaseLabel).toHaveBeenCalledWith("owner/repo", 42, "implementing");
      expect(mockShipManager.updateStatus).toHaveBeenCalledWith("ship-aaa-111", "implementing");
      expect(gateApprovedSpy).toHaveBeenCalledWith("ship-aaa-111", "planning→implementing");
    });

    it("rejects gate and notifies handler", async () => {
      const ship = makeShip({
        status: "planning",
        gateCheck: {
          transition: "planning→implementing",
          gateType: "plan-review",
          status: "pending",
          requestedAt: new Date().toISOString(),
        },
      });
      mockShipManager.resolveShip.mockReturnValue(ship);
      mockShipManager.respondToGate.mockResolvedValue(undefined);

      const result = await handler.handle(
        "fleet-1",
        {
          request: "gate-result",
          shipId: "ship-aaa-111",
          transition: "planning→implementing" as GateTransition,
          verdict: "reject",
          feedback: "Plan lacks test coverage",
        },
        fleetRepos, repoRemotes,
      );

      expect(result).toContain("Gate Rejected");
      expect(result).toContain("Plan lacks test coverage");
      expect(gateRejectedSpy).toHaveBeenCalledWith(
        "ship-aaa-111",
        "planning→implementing",
        "Plan lacks test coverage",
      );
    });

    it("fails gate-result when no pending gate exists", async () => {
      const ship = makeShip({ gateCheck: null });
      mockShipManager.resolveShip.mockReturnValue(ship);

      const result = await handler.handle(
        "fleet-1",
        {
          request: "gate-result",
          shipId: "ship-aaa-111",
          transition: "planning→implementing" as GateTransition,
          verdict: "approve",
        },
        fleetRepos, repoRemotes,
      );
      expect(result).toContain("Gate Result Failed");
    });
  });

  describe("escort-registered", () => {
    it("registers escort agent ID on ship", async () => {
      const ship = makeShip();
      mockShipManager.resolveShip.mockReturnValue(ship);

      const result = await handler.handle(
        "fleet-1",
        {
          request: "escort-registered",
          shipId: "ship-aaa-111",
          agentId: "agent-xyz",
        },
        fleetRepos, repoRemotes,
      );
      expect(result).toContain("Escort Registered");
      expect(mockShipManager.setEscortAgentId).toHaveBeenCalledWith("ship-aaa-111", "agent-xyz");
    });
  });
});
