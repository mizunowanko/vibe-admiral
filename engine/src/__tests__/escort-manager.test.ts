import { describe, expect, it, vi, beforeEach } from "vitest";
import { EscortManager } from "../escort-manager.js";

type MockProcessManager = {
  isRunning: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
};

type MockShipManager = {
  getShip: ReturnType<typeof vi.fn>;
  getDbPath: ReturnType<typeof vi.fn>;
  clearGateCheck: ReturnType<typeof vi.fn>;
  syncPhaseFromDb: ReturnType<typeof vi.fn>;
  sortieEscort: ReturnType<typeof vi.fn>;
  isEscort: ReturnType<typeof vi.fn>;
  getEscortForShip: ReturnType<typeof vi.fn>;
};

function makeShip(overrides: Record<string, unknown> = {}) {
  return {
    id: "ship-001",
    repo: "owner/repo",
    issueNumber: 42,
    worktreePath: "/repo/.worktrees/feature/42-test",
    kind: "ship",
    parentShipId: null,
    ...overrides,
  };
}

function makeEscortShip(parentShipId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "escort-001",
    repo: "owner/repo",
    issueNumber: 42,
    worktreePath: "/repo/.worktrees/feature/42-test",
    kind: "escort",
    parentShipId,
    ...overrides,
  };
}

describe("EscortManager", () => {
  let escortManager: EscortManager;
  let mockProcessManager: MockProcessManager;
  let mockShipManager: MockShipManager;

  beforeEach(() => {
    mockProcessManager = {
      isRunning: vi.fn().mockReturnValue(false),
      kill: vi.fn().mockReturnValue(true),
    };
    mockShipManager = {
      getShip: vi.fn().mockReturnValue(makeShip()),
      getDbPath: vi.fn().mockReturnValue("/tmp/fleet.db"),
      clearGateCheck: vi.fn(),
      syncPhaseFromDb: vi.fn(),
      sortieEscort: vi.fn().mockReturnValue(makeEscortShip("ship-001")),
      isEscort: vi.fn().mockReturnValue(false),
      getEscortForShip: vi.fn().mockReturnValue(undefined),
    };
    escortManager = new EscortManager(
      mockProcessManager as unknown as ConstructorParameters<typeof EscortManager>[0],
      mockShipManager as unknown as ConstructorParameters<typeof EscortManager>[1],
      () => null,
    );
  });

  describe("launchEscort", () => {
    it("launches a persistent Escort via ShipManager.sortieEscort", () => {
      const escortId = escortManager.launchEscort("ship-001");

      expect(escortId).toBe("escort-001");
      expect(mockShipManager.sortieEscort).toHaveBeenCalledWith(makeShip());
    });

    it("prevents duplicate Escorts for the same parent Ship", () => {
      // First launch succeeds
      const first = escortManager.launchEscort("ship-001");
      expect(first).not.toBeNull();

      // Second launch is blocked because the Escort process is running
      mockProcessManager.isRunning.mockReturnValue(true);
      const second = escortManager.launchEscort("ship-001");
      expect(second).toBeNull();
    });

    it("allows re-launch after previous Escort has exited", () => {
      // First launch
      escortManager.launchEscort("ship-001");

      // Escort exits
      mockProcessManager.isRunning.mockReturnValue(false);
      escortManager.onEscortExit("escort-001", 0);

      // Re-launch should succeed
      const newEscort = makeEscortShip("ship-001", { id: "escort-002" });
      mockShipManager.sortieEscort.mockReturnValue(newEscort);
      const escortId = escortManager.launchEscort("ship-001");
      expect(escortId).toBe("escort-002");
    });

    it("returns null if parent Ship not found", () => {
      mockShipManager.getShip.mockReturnValue(undefined);
      const result = escortManager.launchEscort("non-existent");
      expect(result).toBeNull();
    });
  });

  describe("isEscortRunning", () => {
    it("returns true when Escort process is running", () => {
      escortManager.launchEscort("ship-001");
      mockProcessManager.isRunning.mockReturnValue(true);

      expect(escortManager.isEscortRunning("ship-001")).toBe(true);
    });

    it("returns false when no Escort tracked", () => {
      expect(escortManager.isEscortRunning("ship-001")).toBe(false);
    });

    it("returns false when Escort process has died", () => {
      escortManager.launchEscort("ship-001");
      mockProcessManager.isRunning.mockReturnValue(false);

      expect(escortManager.isEscortRunning("ship-001")).toBe(false);
    });

    it("checks DB for restored Escort when not in memory", () => {
      const escort = makeEscortShip("ship-001", { id: "restored-escort" });
      mockShipManager.getEscortForShip.mockReturnValue(escort);
      mockProcessManager.isRunning.mockReturnValue(true);

      expect(escortManager.isEscortRunning("ship-001")).toBe(true);
      expect(mockShipManager.getEscortForShip).toHaveBeenCalledWith("ship-001");
    });
  });

  describe("killEscort", () => {
    it("kills the running Escort and removes tracking", () => {
      escortManager.launchEscort("ship-001");
      const killed = escortManager.killEscort("ship-001");

      expect(killed).toBe(true);
      expect(mockProcessManager.kill).toHaveBeenCalledWith("escort-001");
    });

    it("returns false for Ship without Escort", () => {
      expect(escortManager.killEscort("non-existent")).toBe(false);
    });
  });

  describe("isEscortProcess", () => {
    it("delegates to shipManager.isEscort", () => {
      mockShipManager.isEscort.mockReturnValue(true);
      expect(escortManager.isEscortProcess("some-id")).toBe(true);
      expect(mockShipManager.isEscort).toHaveBeenCalledWith("some-id");
    });

    it("returns false for non-escort ships", () => {
      mockShipManager.isEscort.mockReturnValue(false);
      expect(escortManager.isEscortProcess("ship-001")).toBe(false);
    });
  });

  describe("findShipIdByEscortId", () => {
    it("finds the parent Ship ID for an active Escort", () => {
      escortManager.launchEscort("ship-001");
      const shipId = escortManager.findShipIdByEscortId("escort-001");
      expect(shipId).toBe("ship-001");
    });

    it("falls back to DB lookup for unknown Escort ID", () => {
      mockShipManager.getShip.mockReturnValue(
        makeEscortShip("ship-001", { id: "db-escort" }),
      );
      const shipId = escortManager.findShipIdByEscortId("db-escort");
      expect(shipId).toBe("ship-001");
    });

    it("returns undefined for unknown Escort ID with no DB match", () => {
      mockShipManager.getShip.mockReturnValue(undefined);
      expect(escortManager.findShipIdByEscortId("unknown")).toBeUndefined();
    });
  });

  describe("onEscortExit", () => {
    it("cleans up tracking state on exit", () => {
      escortManager.launchEscort("ship-001");
      escortManager.onEscortExit("escort-001", 0);

      // Should allow re-launch
      const newEscort = makeEscortShip("ship-001", { id: "escort-002" });
      mockShipManager.sortieEscort.mockReturnValue(newEscort);
      const escortId = escortManager.launchEscort("ship-001");
      expect(escortId).toBe("escort-002");
    });

    it("is a no-op for unknown Escort IDs", () => {
      escortManager.onEscortExit("unknown-escort", 0);
      // No error thrown
    });
  });

  describe("killAll", () => {
    it("kills all running Escorts", () => {
      // Launch two Escorts for different Ships
      mockShipManager.getShip
        .mockReturnValueOnce(makeShip({ id: "ship-001" }))
        .mockReturnValueOnce(makeShip({ id: "ship-002", issueNumber: 43 }));
      mockShipManager.sortieEscort
        .mockReturnValueOnce(makeEscortShip("ship-001", { id: "escort-a" }))
        .mockReturnValueOnce(makeEscortShip("ship-002", { id: "escort-b" }));

      escortManager.launchEscort("ship-001");
      escortManager.launchEscort("ship-002");

      escortManager.killAll();

      expect(mockProcessManager.kill).toHaveBeenCalledTimes(2);
    });
  });
});
