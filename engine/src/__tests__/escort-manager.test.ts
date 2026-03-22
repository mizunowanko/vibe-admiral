import { describe, expect, it, vi, beforeEach } from "vitest";
import { EscortManager } from "../escort-manager.js";

type MockProcessManager = {
  isRunning: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  launchEscort: ReturnType<typeof vi.fn>;
};

type MockShipManager = {
  getShip: ReturnType<typeof vi.fn>;
  getDbPath: ReturnType<typeof vi.fn>;
  clearGateCheck: ReturnType<typeof vi.fn>;
  syncPhaseFromDb: ReturnType<typeof vi.fn>;
};

function makeShip(overrides: Record<string, unknown> = {}) {
  return {
    id: "ship-001",
    repo: "owner/repo",
    issueNumber: 42,
    worktreePath: "/repo/.worktrees/feature/42-test",
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
      launchEscort: vi.fn(),
    };
    mockShipManager = {
      getShip: vi.fn().mockReturnValue(makeShip()),
      getDbPath: vi.fn().mockReturnValue("/tmp/fleet.db"),
      clearGateCheck: vi.fn(),
      syncPhaseFromDb: vi.fn(),
    };
    escortManager = new EscortManager(
      mockProcessManager as unknown as ConstructorParameters<typeof EscortManager>[0],
      mockShipManager as unknown as ConstructorParameters<typeof EscortManager>[1],
      () => null,
    );
  });

  describe("launchEscort", () => {
    it("launches an Escort for a gate phase", () => {
      const escortId = escortManager.launchEscort(
        "ship-001",
        "planning-gate",
        "plan-review",
      );

      expect(escortId).toBe("escort-ship-001-planning-gate");
      expect(mockProcessManager.launchEscort).toHaveBeenCalledWith(
        "escort-ship-001-planning-gate",
        "/repo/.worktrees/feature/42-test",
        "planning-gate",
        42,
        {
          VIBE_ADMIRAL_SHIP_ID: "ship-001",
          VIBE_ADMIRAL_MAIN_REPO: "owner/repo",
          VIBE_ADMIRAL_ENGINE_PORT: "9721",
        },
      );
    });

    it("maps implementing-gate to implementing-gate skill", () => {
      escortManager.launchEscort("ship-001", "implementing-gate", "code-review");

      expect(mockProcessManager.launchEscort).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        "implementing-gate",
        expect.any(Number),
        expect.any(Object),
      );
    });

    it("prevents duplicate Escorts for the same Ship", () => {
      // First launch succeeds
      const first = escortManager.launchEscort("ship-001", "planning-gate", "plan-review");
      expect(first).not.toBeNull();

      // Second launch is blocked because the Escort process is running
      mockProcessManager.isRunning.mockReturnValue(true);
      const second = escortManager.launchEscort("ship-001", "planning-gate", "plan-review");
      expect(second).toBeNull();
    });

    it("allows re-launch after previous Escort has exited", () => {
      // First launch
      escortManager.launchEscort("ship-001", "planning-gate", "plan-review");

      // Escort exits
      mockProcessManager.isRunning.mockReturnValue(false);
      escortManager.onEscortExit("escort-ship-001-planning-gate", 0);

      // Re-launch should succeed
      const escortId = escortManager.launchEscort("ship-001", "implementing-gate", "code-review");
      expect(escortId).not.toBeNull();
    });

    it("returns null if Ship not found", () => {
      mockShipManager.getShip.mockReturnValue(undefined);
      const result = escortManager.launchEscort("non-existent", "planning-gate", "plan-review");
      expect(result).toBeNull();
    });

    it("does not pass VIBE_ADMIRAL_DB_PATH (API-based communication)", () => {
      escortManager.launchEscort("ship-001", "planning-gate", "plan-review");

      const envArg = mockProcessManager.launchEscort.mock.calls[0]![4] as Record<string, string>;
      expect(envArg).not.toHaveProperty("VIBE_ADMIRAL_DB_PATH");
    });
  });

  describe("getEscort", () => {
    it("returns Escort info after launch", () => {
      escortManager.launchEscort("ship-001", "planning-gate", "plan-review");
      const info = escortManager.getEscort("ship-001");
      expect(info).toEqual({
        escortId: "escort-ship-001-planning-gate",
        shipId: "ship-001",
        gatePhase: "planning-gate",
        gateType: "plan-review",
        startedAt: expect.any(String),
      });
    });

    it("returns undefined for Ship without Escort", () => {
      expect(escortManager.getEscort("ship-001")).toBeUndefined();
    });
  });

  describe("isEscortRunning", () => {
    it("returns true when Escort process is running", () => {
      escortManager.launchEscort("ship-001", "planning-gate", "plan-review");
      mockProcessManager.isRunning.mockReturnValue(true);

      expect(escortManager.isEscortRunning("ship-001")).toBe(true);
    });

    it("returns false when no Escort tracked", () => {
      expect(escortManager.isEscortRunning("ship-001")).toBe(false);
    });

    it("returns false when Escort process has died", () => {
      escortManager.launchEscort("ship-001", "planning-gate", "plan-review");
      mockProcessManager.isRunning.mockReturnValue(false);

      expect(escortManager.isEscortRunning("ship-001")).toBe(false);
    });
  });

  describe("killEscort", () => {
    it("kills the running Escort and removes tracking", () => {
      escortManager.launchEscort("ship-001", "planning-gate", "plan-review");
      const killed = escortManager.killEscort("ship-001");

      expect(killed).toBe(true);
      expect(mockProcessManager.kill).toHaveBeenCalledWith("escort-ship-001-planning-gate");
      expect(escortManager.getEscort("ship-001")).toBeUndefined();
    });

    it("returns false for Ship without Escort", () => {
      expect(escortManager.killEscort("non-existent")).toBe(false);
    });
  });

  describe("isEscortProcess", () => {
    it("identifies Escort process IDs", () => {
      expect(escortManager.isEscortProcess("escort-abc-planning-gate")).toBe(true);
      expect(escortManager.isEscortProcess("ship-001")).toBe(false);
      expect(escortManager.isEscortProcess("flagship-1")).toBe(false);
    });
  });

  describe("findShipIdByEscortId", () => {
    it("finds the Ship ID for an active Escort", () => {
      escortManager.launchEscort("ship-001", "planning-gate", "plan-review");
      const shipId = escortManager.findShipIdByEscortId("escort-ship-001-planning-gate");
      expect(shipId).toBe("ship-001");
    });

    it("returns undefined for unknown Escort ID", () => {
      expect(escortManager.findShipIdByEscortId("unknown")).toBeUndefined();
    });
  });

  describe("onEscortExit", () => {
    it("cleans up tracking state on exit", () => {
      escortManager.launchEscort("ship-001", "planning-gate", "plan-review");
      escortManager.onEscortExit("escort-ship-001-planning-gate", 0);

      expect(escortManager.getEscort("ship-001")).toBeUndefined();
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

      escortManager.launchEscort("ship-001", "planning-gate", "plan-review");
      escortManager.launchEscort("ship-002", "implementing-gate", "code-review");

      escortManager.killAll();

      expect(mockProcessManager.kill).toHaveBeenCalledTimes(2);
      expect(escortManager.getEscort("ship-001")).toBeUndefined();
      expect(escortManager.getEscort("ship-002")).toBeUndefined();
    });
  });
});
