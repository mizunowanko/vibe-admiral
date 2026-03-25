import { describe, expect, it, vi, beforeEach } from "vitest";
import { EscortManager } from "../escort-manager.js";

type MockProcessManager = {
  isRunning: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  sortie: ReturnType<typeof vi.fn>;
  resumeSession: ReturnType<typeof vi.fn>;
};

type MockShipManager = {
  getShip: ReturnType<typeof vi.fn>;
  clearGateCheck: ReturnType<typeof vi.fn>;
  syncPhaseFromDb: ReturnType<typeof vi.fn>;
};

type MockFleetDatabase = {
  getEscortByShipId: ReturnType<typeof vi.fn>;
  getEscortById: ReturnType<typeof vi.fn>;
  upsertEscort: ReturnType<typeof vi.fn>;
  updateEscortPhase: ReturnType<typeof vi.fn>;
  updateEscortSessionId: ReturnType<typeof vi.fn>;
  getShipById: ReturnType<typeof vi.fn>;
  persistPhaseTransition: ReturnType<typeof vi.fn>;
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
  let mockDb: MockFleetDatabase;

  beforeEach(() => {
    mockProcessManager = {
      isRunning: vi.fn().mockReturnValue(false),
      kill: vi.fn().mockReturnValue(true),
      sortie: vi.fn(),
      resumeSession: vi.fn(),
    };
    mockShipManager = {
      getShip: vi.fn().mockReturnValue(makeShip()),
      clearGateCheck: vi.fn(),
      syncPhaseFromDb: vi.fn(),
    };
    mockDb = {
      getEscortByShipId: vi.fn().mockReturnValue(undefined),
      getEscortById: vi.fn().mockReturnValue(undefined),
      upsertEscort: vi.fn(),
      updateEscortPhase: vi.fn(),
      updateEscortSessionId: vi.fn(),
      getShipById: vi.fn(),
      persistPhaseTransition: vi.fn(),
    };
    escortManager = new EscortManager(
      mockProcessManager as unknown as ConstructorParameters<typeof EscortManager>[0],
      mockShipManager as unknown as ConstructorParameters<typeof EscortManager>[1],
      () => mockDb as unknown as ConstructorParameters<typeof EscortManager>[2] extends () => infer R ? R : never,
    );
  });

  describe("launchEscort", () => {
    it("launches a new Escort via processManager.sortie for first gate", () => {
      const escortId = escortManager.launchEscort("ship-001", "plan-gate");

      expect(escortId).not.toBeNull();
      expect(mockDb.upsertEscort).toHaveBeenCalled();
      expect(mockProcessManager.sortie).toHaveBeenCalled();

      const sortieCall = mockProcessManager.sortie.mock.calls[0]!;
      expect(sortieCall[0]).toBe(escortId); // id
      expect(sortieCall[1]).toBe("/repo/.worktrees/feature/42-test"); // worktreePath
      expect(sortieCall[2]).toBe(42); // issueNumber
      expect(sortieCall[3]).toEqual(expect.stringContaining("planning-gate")); // prompt
      expect(sortieCall[4]).toBe("/escort"); // skill
      expect(sortieCall[5]).toEqual(
        expect.objectContaining({
          VIBE_ADMIRAL_MAIN_REPO: "owner/repo",
          VIBE_ADMIRAL_SHIP_ID: escortId,
          VIBE_ADMIRAL_PARENT_SHIP_ID: "ship-001",
        }),
      ); // env
    });

    it("resumes existing Escort with sessionId for subsequent gates", () => {
      mockDb.getEscortByShipId.mockReturnValue({
        id: "escort-001",
        shipId: "ship-001",
        sessionId: "session-abc",
        processPid: null,
        phase: "plan",
        createdAt: new Date().toISOString(),
        completedAt: null,
      });

      const escortId = escortManager.launchEscort("ship-001", "coding-gate");

      expect(escortId).toBe("escort-001");
      expect(mockProcessManager.resumeSession).toHaveBeenCalledWith(
        "escort-001",
        "session-abc",
        expect.stringContaining("coding-gate"),
        "/repo/.worktrees/feature/42-test",
        expect.any(Object),
      );
    });

    it("prevents duplicate Escorts for the same parent Ship", () => {
      // First launch succeeds
      const first = escortManager.launchEscort("ship-001", "plan-gate");
      expect(first).not.toBeNull();

      // Second launch is blocked because the Escort process is running
      mockProcessManager.isRunning.mockReturnValue(true);
      const second = escortManager.launchEscort("ship-001", "plan-gate");
      expect(second).toBeNull();
    });

    it("allows re-launch after previous Escort has exited", () => {
      // First launch
      const firstId = escortManager.launchEscort("ship-001", "plan-gate");
      expect(firstId).not.toBeNull();

      // Escort exits
      mockProcessManager.isRunning.mockReturnValue(false);
      mockDb.getShipById.mockReturnValue({ ...makeShip(), phase: "coding" });
      escortManager.onEscortExit(firstId!, 0);

      // Re-launch should succeed
      const secondId = escortManager.launchEscort("ship-001", "coding-gate");
      expect(secondId).not.toBeNull();

      // Verify the re-launched sortie has correct arguments
      const lastCall = mockProcessManager.sortie.mock.calls.at(-1)!;
      expect(lastCall[0]).toBe(secondId); // id
      expect(lastCall[1]).toBe("/repo/.worktrees/feature/42-test"); // worktreePath
      expect(lastCall[2]).toBe(42); // issueNumber
      expect(lastCall[3]).toEqual(expect.stringContaining("implementing-gate")); // prompt
      expect(lastCall[4]).toBe("/escort"); // skill
      expect(lastCall[5]).toEqual(
        expect.objectContaining({
          VIBE_ADMIRAL_MAIN_REPO: "owner/repo",
          VIBE_ADMIRAL_SHIP_ID: secondId,
          VIBE_ADMIRAL_PARENT_SHIP_ID: "ship-001",
        }),
      ); // env
    });

    it("returns null if parent Ship not found", () => {
      mockShipManager.getShip.mockReturnValue(undefined);
      const result = escortManager.launchEscort("non-existent", "plan-gate");
      expect(result).toBeNull();
    });
  });

  describe("isEscortRunning", () => {
    it("returns true when Escort process is running", () => {
      escortManager.launchEscort("ship-001", "plan-gate");
      mockProcessManager.isRunning.mockReturnValue(true);

      expect(escortManager.isEscortRunning("ship-001")).toBe(true);
    });

    it("returns false when no Escort tracked", () => {
      expect(escortManager.isEscortRunning("ship-001")).toBe(false);
    });

    it("returns false when Escort process has died", () => {
      escortManager.launchEscort("ship-001", "plan-gate");
      mockProcessManager.isRunning.mockReturnValue(false);

      expect(escortManager.isEscortRunning("ship-001")).toBe(false);
    });

    it("checks DB for restored Escort when not in memory", () => {
      mockDb.getEscortByShipId.mockReturnValue({
        id: "restored-escort",
        shipId: "ship-001",
        sessionId: null,
        processPid: null,
        phase: "plan",
        createdAt: new Date().toISOString(),
        completedAt: null,
      });
      mockProcessManager.isRunning.mockReturnValue(true);

      expect(escortManager.isEscortRunning("ship-001")).toBe(true);
      expect(mockDb.getEscortByShipId).toHaveBeenCalledWith("ship-001");
    });
  });

  describe("killEscort", () => {
    it("kills the running Escort and removes tracking", () => {
      const escortId = escortManager.launchEscort("ship-001", "plan-gate");

      const killed = escortManager.killEscort("ship-001");

      expect(killed).toBe(true);
      expect(mockProcessManager.kill).toHaveBeenCalledWith(escortId);
    });

    it("returns false for Ship without Escort", () => {
      expect(escortManager.killEscort("non-existent")).toBe(false);
    });
  });

  describe("isEscortProcess", () => {
    it("returns true for active Escort in memory", () => {
      const escortId = escortManager.launchEscort("ship-001", "plan-gate");
      expect(escortManager.isEscortProcess(escortId!)).toBe(true);
    });

    it("returns true for Escort found in DB", () => {
      mockDb.getEscortById.mockReturnValue({
        id: "db-escort",
        shipId: "ship-001",
        sessionId: null,
        processPid: null,
        phase: "plan",
        createdAt: new Date().toISOString(),
        completedAt: null,
      });
      expect(escortManager.isEscortProcess("db-escort")).toBe(true);
    });

    it("returns false for non-escort process IDs", () => {
      expect(escortManager.isEscortProcess("ship-001")).toBe(false);
    });
  });

  describe("findShipIdByEscortId", () => {
    it("finds the parent Ship ID for an active Escort", () => {
      const escortId = escortManager.launchEscort("ship-001", "plan-gate");
      const shipId = escortManager.findShipIdByEscortId(escortId!);
      expect(shipId).toBe("ship-001");
    });

    it("falls back to DB lookup for unknown Escort ID", () => {
      mockDb.getEscortById.mockReturnValue({
        id: "db-escort",
        shipId: "ship-001",
        sessionId: null,
        processPid: null,
        phase: "plan",
        createdAt: new Date().toISOString(),
        completedAt: null,
      });
      const shipId = escortManager.findShipIdByEscortId("db-escort");
      expect(shipId).toBe("ship-001");
    });

    it("returns undefined for unknown Escort ID with no DB match", () => {
      expect(escortManager.findShipIdByEscortId("unknown")).toBeUndefined();
    });
  });

  describe("setEscortSessionId", () => {
    it("persists session ID to escorts table", () => {
      escortManager.setEscortSessionId("escort-001", "session-abc");
      expect(mockDb.updateEscortSessionId).toHaveBeenCalledWith("escort-001", "session-abc");
    });
  });

  describe("onEscortExit", () => {
    it("cleans up tracking state on exit", () => {
      const escortId = escortManager.launchEscort("ship-001", "plan-gate");

      // Parent already moved past gate (verdict submitted)
      mockDb.getShipById.mockReturnValue({ ...makeShip(), phase: "coding" });
      escortManager.onEscortExit(escortId!, 0);

      // Should allow re-launch
      const newEscortId = escortManager.launchEscort("ship-001", "coding-gate");
      expect(newEscortId).not.toBeNull();
    });

    it("is a no-op for unknown Escort IDs", () => {
      escortManager.onEscortExit("unknown-escort", 0);
      // No error thrown
    });

    describe("gate phase revert via XState (ESCORT_DIED)", () => {
      let mockActorManager: {
        send: ReturnType<typeof vi.fn>;
        requestTransition: ReturnType<typeof vi.fn>;
      };
      let deathHandler: ReturnType<typeof vi.fn>;

      beforeEach(() => {
        mockActorManager = {
          send: vi.fn().mockReturnValue(true),
          requestTransition: vi.fn(),
        };
        deathHandler = vi.fn();

        escortManager.setActorManager(mockActorManager as unknown as Parameters<EscortManager["setActorManager"]>[0]);
        escortManager.setEscortDeathHandler(deathHandler as unknown as Parameters<EscortManager["setEscortDeathHandler"]>[0]);
      });

      it("reverts gate phase via XState requestTransition and persists to DB", () => {
        const escortId = escortManager.launchEscort("ship-001", "plan-gate");

        // Parent ship is in gate phase
        mockDb.getShipById.mockReturnValue({
          ...makeShip(),
          phase: "plan-gate",
          issueTitle: "Test issue",
        });
        mockActorManager.requestTransition.mockReturnValue({
          success: true,
          fromPhase: "plan-gate",
          toPhase: "plan",
        });

        escortManager.onEscortExit(escortId!, 1);

        expect(mockActorManager.requestTransition).toHaveBeenCalledWith("ship-001", {
          type: "ESCORT_DIED",
          exitCode: 1,
          feedback: expect.stringContaining("exited unexpectedly"),
        });

        expect(mockDb.persistPhaseTransition).toHaveBeenCalledWith(
          "ship-001",
          "plan-gate",
          "plan",
          "escort",
          expect.objectContaining({ gate_result: "rejected" }),
        );

        expect(mockShipManager.syncPhaseFromDb).toHaveBeenCalledWith("ship-001");
        expect(mockShipManager.clearGateCheck).toHaveBeenCalledWith("ship-001");
        expect(deathHandler).toHaveBeenCalled();
      });

      it("does not persist to DB when XState rejects ESCORT_DIED", () => {
        const escortId = escortManager.launchEscort("ship-001", "plan-gate");

        mockDb.getShipById.mockReturnValue({
          ...makeShip(),
          phase: "plan-gate",
          issueTitle: "Test issue",
        });
        mockActorManager.requestTransition.mockReturnValue({
          success: false,
          currentPhase: "coding",
        });

        escortManager.onEscortExit(escortId!, 1);

        expect(mockActorManager.requestTransition).toHaveBeenCalled();
        expect(mockDb.persistPhaseTransition).not.toHaveBeenCalled();
      });

      it("skips XState when parent is no longer in gate phase", () => {
        const escortId = escortManager.launchEscort("ship-001", "plan-gate");

        // Parent already moved past gate (verdict was submitted)
        mockDb.getShipById.mockReturnValue({
          ...makeShip(),
          phase: "coding",
        });

        escortManager.onEscortExit(escortId!, 0);

        expect(mockActorManager.requestTransition).not.toHaveBeenCalled();
        expect(mockDb.persistPhaseTransition).not.toHaveBeenCalled();
        expect(mockShipManager.clearGateCheck).toHaveBeenCalledWith("ship-001");
      });
    });
  });

  describe("notifyLaunchFailure", () => {
    it("sends notification via onEscortDeathCallback", () => {
      const deathHandler = vi.fn();
      escortManager.setEscortDeathHandler(deathHandler);

      escortManager.notifyLaunchFailure("ship-001", "plan-gate", "test reason");

      expect(deathHandler).toHaveBeenCalledWith(
        "ship-001",
        expect.stringContaining("Escort launch failed"),
      );
      expect(deathHandler).toHaveBeenCalledWith(
        "ship-001",
        expect.stringContaining("test reason"),
      );
    });

    it("is a no-op when parent Ship not found", () => {
      const deathHandler = vi.fn();
      escortManager.setEscortDeathHandler(deathHandler);
      mockShipManager.getShip.mockReturnValue(undefined);

      escortManager.notifyLaunchFailure("non-existent", "plan-gate", "reason");

      expect(deathHandler).not.toHaveBeenCalled();
    });

    it("is a no-op when no handler is set", () => {
      // No handler set — should not throw
      escortManager.notifyLaunchFailure("ship-001", "plan-gate", "reason");
    });
  });

  describe("cleanupForDoneShip", () => {
    it("kills Escort process and marks DB record as done", () => {
      const escortId = escortManager.launchEscort("ship-001", "plan-gate");

      escortManager.cleanupForDoneShip("ship-001");

      expect(mockProcessManager.kill).toHaveBeenCalledWith(escortId);
      expect(mockDb.updateEscortPhase).toHaveBeenCalledWith(
        escortId,
        "done",
        expect.any(String),
      );
    });

    it("falls back to DB lookup when Escort not in memory", () => {
      mockDb.getEscortByShipId.mockReturnValue({
        id: "db-escort",
        shipId: "ship-001",
        sessionId: null,
        processPid: null,
        phase: "plan",
        createdAt: new Date().toISOString(),
        completedAt: null,
      });

      escortManager.cleanupForDoneShip("ship-001");

      expect(mockDb.getEscortByShipId).toHaveBeenCalledWith("ship-001");
      expect(mockProcessManager.kill).toHaveBeenCalledWith("db-escort");
      expect(mockDb.updateEscortPhase).toHaveBeenCalledWith(
        "db-escort",
        "done",
        expect.any(String),
      );
    });

    it("is a no-op when no Escort exists for the parent Ship", () => {
      escortManager.cleanupForDoneShip("ship-without-escort");

      expect(mockProcessManager.kill).not.toHaveBeenCalled();
      expect(mockDb.updateEscortPhase).not.toHaveBeenCalled();
    });
  });

  describe("killAll", () => {
    it("kills all running Escorts", () => {
      // Launch two Escorts for different Ships
      mockShipManager.getShip
        .mockReturnValueOnce(makeShip({ id: "ship-001" }))
        .mockReturnValueOnce(makeShip({ id: "ship-002", issueNumber: 43 }));

      escortManager.launchEscort("ship-001", "plan-gate");
      escortManager.launchEscort("ship-002", "plan-gate");

      escortManager.killAll();

      expect(mockProcessManager.kill).toHaveBeenCalledTimes(2);
    });
  });
});
