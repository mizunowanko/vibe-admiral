import { describe, expect, it, vi, beforeEach } from "vitest";
import { EscortManager } from "../escort-manager.js";

// Mock filesystem operations used by stashForEscort / restoreFromEscortStash / deployCustomInstructions
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  readFile: vi.fn().mockResolvedValue(""),
  rm: vi.fn().mockResolvedValue(undefined),
}));

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
  updatePhase: ReturnType<typeof vi.fn>;
};

type MockFleetDatabase = {
  getEscortByShipId: ReturnType<typeof vi.fn>;
  getEscortById: ReturnType<typeof vi.fn>;
  upsertEscort: ReturnType<typeof vi.fn>;
  updateEscortPhase: ReturnType<typeof vi.fn>;
  updateEscortSessionId: ReturnType<typeof vi.fn>;
  getShipById: ReturnType<typeof vi.fn>;
  persistPhaseTransition: ReturnType<typeof vi.fn>;
  getGateIntent: ReturnType<typeof vi.fn>;
  setGateIntent: ReturnType<typeof vi.fn>;
  clearGateIntent: ReturnType<typeof vi.fn>;
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
      updatePhase: vi.fn(),
    };
    mockDb = {
      getEscortByShipId: vi.fn().mockReturnValue(undefined),
      getEscortById: vi.fn().mockReturnValue(undefined),
      upsertEscort: vi.fn(),
      updateEscortPhase: vi.fn(),
      updateEscortSessionId: vi.fn(),
      getShipById: vi.fn(),
      persistPhaseTransition: vi.fn(),
      getGateIntent: vi.fn().mockReturnValue(undefined),
      setGateIntent: vi.fn(),
      clearGateIntent: vi.fn(),
    };
    escortManager = new EscortManager(
      mockProcessManager as unknown as ConstructorParameters<typeof EscortManager>[0],
      mockShipManager as unknown as ConstructorParameters<typeof EscortManager>[1],
      () => mockDb as unknown as ConstructorParameters<typeof EscortManager>[2] extends () => infer R ? R : never,
    );
  });

  describe("launchEscort", () => {
    it("launches a new Escort via processManager.sortie for first gate", async () => {
      const escortId = await escortManager.launchEscort("ship-001", "plan-gate");

      expect(escortId).not.toBeNull();
      expect(mockDb.upsertEscort).toHaveBeenCalled();
      expect(mockProcessManager.sortie).toHaveBeenCalled();

      const sortieCall = mockProcessManager.sortie.mock.calls[0]!;
      expect(sortieCall[0]).toBe(escortId); // id
      expect(sortieCall[1]).toBe("/repo/.worktrees/feature/42-test"); // worktreePath
      expect(sortieCall[2]).toBe(42); // issueNumber
      expect(sortieCall[3]).toEqual(expect.stringContaining("plan-gate")); // prompt
      expect(sortieCall[4]).toBe("/escort-planning-gate"); // skill
      expect(sortieCall[5]).toEqual(
        expect.objectContaining({
          VIBE_ADMIRAL_MAIN_REPO: "owner/repo",
          VIBE_ADMIRAL_SHIP_ID: escortId,
          VIBE_ADMIRAL_PARENT_SHIP_ID: "ship-001",
        }),
      ); // env
    });

    it("resumes existing Escort with sessionId for subsequent gates", async () => {
      mockDb.getEscortByShipId.mockReturnValue({
        id: "escort-001",
        shipId: "ship-001",
        sessionId: "session-abc",
        processPid: null,
        phase: "plan",
        createdAt: new Date().toISOString(),
        completedAt: null,
      });

      const escortId = await escortManager.launchEscort("ship-001", "coding-gate");

      expect(escortId).toBe("escort-001");
      expect(mockProcessManager.resumeSession).toHaveBeenCalledWith(
        "escort-001",
        "session-abc",
        expect.stringContaining("coding-gate"),
        "/repo/.worktrees/feature/42-test",
        expect.any(Object),
        undefined,
        "escort-log.jsonl",
      );
    });

    it("prevents duplicate Escorts for the same parent Ship", async () => {
      // First launch succeeds
      const first = await escortManager.launchEscort("ship-001", "plan-gate");
      expect(first).not.toBeNull();

      // Second launch is blocked because the Escort process is running
      mockProcessManager.isRunning.mockReturnValue(true);
      const second = await escortManager.launchEscort("ship-001", "plan-gate");
      expect(second).toBeNull();
    });

    it("allows re-launch after previous Escort has exited", async () => {
      // First launch
      const firstId = await escortManager.launchEscort("ship-001", "plan-gate");
      expect(firstId).not.toBeNull();

      // Escort exits
      mockProcessManager.isRunning.mockReturnValue(false);
      mockDb.getShipById.mockReturnValue({ ...makeShip(), phase: "coding" });
      escortManager.onEscortExit(firstId!, 0);

      // Re-launch should succeed
      const secondId = await escortManager.launchEscort("ship-001", "coding-gate");
      expect(secondId).not.toBeNull();

      // Verify the re-launched sortie has correct arguments
      const lastCall = mockProcessManager.sortie.mock.calls.at(-1)!;
      expect(lastCall[0]).toBe(secondId); // id
      expect(lastCall[1]).toBe("/repo/.worktrees/feature/42-test"); // worktreePath
      expect(lastCall[2]).toBe(42); // issueNumber
      expect(lastCall[3]).toEqual(expect.stringContaining("coding-gate")); // prompt
      expect(lastCall[4]).toBe("/escort-implementing-gate"); // skill
      expect(lastCall[5]).toEqual(
        expect.objectContaining({
          VIBE_ADMIRAL_MAIN_REPO: "owner/repo",
          VIBE_ADMIRAL_SHIP_ID: secondId,
          VIBE_ADMIRAL_PARENT_SHIP_ID: "ship-001",
        }),
      ); // env
    });

    it("returns null if parent Ship not found", async () => {
      mockShipManager.getShip.mockReturnValue(undefined);
      const result = await escortManager.launchEscort("non-existent", "plan-gate");
      expect(result).toBeNull();
    });
  });

  describe("isEscortRunning", () => {
    it("returns true when Escort process is running", async () => {
      await escortManager.launchEscort("ship-001", "plan-gate");
      mockProcessManager.isRunning.mockReturnValue(true);

      expect(escortManager.isEscortRunning("ship-001")).toBe(true);
    });

    it("returns false when no Escort tracked", () => {
      expect(escortManager.isEscortRunning("ship-001")).toBe(false);
    });

    it("returns false when Escort process has died", async () => {
      await escortManager.launchEscort("ship-001", "plan-gate");
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
    it("kills the running Escort and removes tracking", async () => {
      const escortId = await escortManager.launchEscort("ship-001", "plan-gate");

      const killed = escortManager.killEscort("ship-001");

      expect(killed).toBe(true);
      expect(mockProcessManager.kill).toHaveBeenCalledWith(escortId);
    });

    it("returns false for Ship without Escort", () => {
      expect(escortManager.killEscort("non-existent")).toBe(false);
    });
  });

  describe("isEscortProcess", () => {
    it("returns true for active Escort in memory", async () => {
      const escortId = await escortManager.launchEscort("ship-001", "plan-gate");
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
    it("finds the parent Ship ID for an active Escort", async () => {
      const escortId = await escortManager.launchEscort("ship-001", "plan-gate");
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
    it("cleans up tracking state on exit", async () => {
      const escortId = await escortManager.launchEscort("ship-001", "plan-gate");

      // Parent already moved past gate (verdict submitted)
      mockDb.getShipById.mockReturnValue({ ...makeShip(), phase: "coding" });
      escortManager.onEscortExit(escortId!, 0);

      // Should allow re-launch
      const newEscortId = await escortManager.launchEscort("ship-001", "coding-gate");
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
        getContext: ReturnType<typeof vi.fn>;
        getPersistedSnapshot: ReturnType<typeof vi.fn>;
      };
      let mockPhaseTx: {
        commit: ReturnType<typeof vi.fn>;
      };
      let deathHandler: ReturnType<typeof vi.fn>;

      beforeEach(() => {
        mockActorManager = {
          send: vi.fn().mockReturnValue(true),
          requestTransition: vi.fn(),
          getContext: vi.fn().mockReturnValue({ escortFailCount: 0 }),
          getPersistedSnapshot: vi.fn().mockReturnValue({ value: "plan", context: {} }),
        };
        mockPhaseTx = {
          commit: vi.fn().mockReturnValue({ success: true, fromPhase: "plan-gate", toPhase: "plan" }),
        };
        deathHandler = vi.fn();

        escortManager.setActorManager(mockActorManager as unknown as Parameters<EscortManager["setActorManager"]>[0]);
        escortManager.setPhaseTransactionService(mockPhaseTx as unknown as Parameters<EscortManager["setPhaseTransactionService"]>[0]);
        escortManager.setEscortDeathHandler(deathHandler as unknown as Parameters<EscortManager["setEscortDeathHandler"]>[0]);
      });

      it("reverts gate phase via PhaseTransactionService.commit()", async () => {
        const escortId = await escortManager.launchEscort("ship-001", "plan-gate");

        mockDb.getShipById.mockReturnValue({
          ...makeShip(),
          phase: "plan-gate",
          issueTitle: "Test issue",
        });

        escortManager.onEscortExit(escortId!, 1);

        expect(mockPhaseTx.commit).toHaveBeenCalledWith("ship-001", {
          event: expect.objectContaining({ type: "ESCORT_DIED", exitCode: 1 }),
          triggeredBy: "escort",
          metadata: expect.objectContaining({ gate_result: "rejected" }),
        });
        expect(deathHandler).toHaveBeenCalled();
      });

      it("logs error when PhaseTransactionService.commit() fails for ESCORT_DIED", async () => {
        const escortId = await escortManager.launchEscort("ship-001", "plan-gate");

        mockDb.getShipById.mockReturnValue({
          ...makeShip(),
          phase: "plan-gate",
          issueTitle: "Test issue",
        });
        mockPhaseTx.commit.mockReturnValue({
          success: false,
          error: "Transition rejected",
          code: "TRANSITION_REJECTED",
        });

        escortManager.onEscortExit(escortId!, 1);

        expect(mockPhaseTx.commit).toHaveBeenCalled();
        expect(deathHandler).toHaveBeenCalled();
      });

      it("skips transition when parent is no longer in gate phase", async () => {
        const escortId = await escortManager.launchEscort("ship-001", "plan-gate");

        // Parent already moved past gate (verdict was submitted)
        mockDb.getShipById.mockReturnValue({
          ...makeShip(),
          phase: "coding",
        });

        escortManager.onEscortExit(escortId!, 0);

        expect(mockPhaseTx.commit).not.toHaveBeenCalled();
        expect(mockShipManager.clearGateCheck).toHaveBeenCalledWith("ship-001");
      });

      it("auto-approves when Escort dies with approve gate-intent", async () => {
        const escortId = await escortManager.launchEscort("ship-001", "coding-gate");

        // Parent ship still in coding-gate
        mockDb.getShipById.mockReturnValue({
          ...makeShip(),
          phase: "coding-gate",
          issueTitle: "Test issue",
        });

        // Escort declared approve intent before dying (DB-backed)
        mockDb.getGateIntent.mockReturnValue({
          verdict: "approve",
          feedback: null,
          commentUrl: null,
          declaredAt: new Date().toISOString(),
        });

        mockPhaseTx.commit.mockReturnValue({
          success: true,
          fromPhase: "coding-gate",
          toPhase: "qa",
        });

        escortManager.onEscortExit(escortId!, 1);

        // Should use PhaseTransactionService with GATE_APPROVED
        expect(mockPhaseTx.commit).toHaveBeenCalledWith("ship-001", {
          event: { type: "GATE_APPROVED" },
          triggeredBy: "escort",
          metadata: expect.objectContaining({
            gate_result: "approved",
            fallback: true,
          }),
        });

        // Should NOT notify death handler (auto-approved successfully)
        expect(deathHandler).not.toHaveBeenCalled();
      });

      it("reverts normally when Escort dies with reject gate-intent", async () => {
        const escortId = await escortManager.launchEscort("ship-001", "coding-gate");

        mockDb.getShipById.mockReturnValue({
          ...makeShip(),
          phase: "coding-gate",
          issueTitle: "Test issue",
        });

        // Escort declared reject intent (DB-backed)
        mockDb.getGateIntent.mockReturnValue({
          verdict: "reject",
          feedback: "Tests missing",
          commentUrl: null,
          declaredAt: new Date().toISOString(),
        });

        escortManager.onEscortExit(escortId!, 1);

        // Should send ESCORT_DIED (not GATE_APPROVED) — reject intent doesn't auto-approve
        expect(mockPhaseTx.commit).toHaveBeenCalledWith("ship-001", {
          event: expect.objectContaining({ type: "ESCORT_DIED", exitCode: 1 }),
          triggeredBy: "escort",
          metadata: expect.objectContaining({ gate_result: "rejected" }),
        });
      });

      it("reverts normally when no gate-intent is stored", async () => {
        const escortId = await escortManager.launchEscort("ship-001", "coding-gate");

        mockDb.getShipById.mockReturnValue({
          ...makeShip(),
          phase: "coding-gate",
          issueTitle: "Test issue",
        });

        // No gate-intent set (DB returns undefined)

        escortManager.onEscortExit(escortId!, 1);

        // Should commit ESCORT_DIED via PhaseTransactionService
        expect(mockPhaseTx.commit).toHaveBeenCalledWith("ship-001", {
          event: expect.objectContaining({ type: "ESCORT_DIED", exitCode: 1 }),
          triggeredBy: "escort",
          metadata: expect.objectContaining({ gate_result: "rejected" }),
        });
      });

      it("clears gate-intent on successful verdict (non-gate phase)", async () => {
        const escortId = await escortManager.launchEscort("ship-001", "coding-gate");

        // Set intent
        escortManager.setGateIntent("ship-001", {
          verdict: "approve",
          declaredAt: new Date().toISOString(),
        });

        // Verdict was already submitted (phase moved past gate)
        mockDb.getShipById.mockReturnValue({
          ...makeShip(),
          phase: "qa",
        });

        escortManager.onEscortExit(escortId!, 0);

        // Intent should be cleared
        expect(escortManager.getGateIntent("ship-001")).toBeUndefined();
      });

      it("falls through to revert when fallback GATE_APPROVED fails", async () => {
        const escortId = await escortManager.launchEscort("ship-001", "coding-gate");

        mockDb.getShipById.mockReturnValue({
          ...makeShip(),
          phase: "coding-gate",
          issueTitle: "Test issue",
        });

        // DB-backed gate intent
        mockDb.getGateIntent.mockReturnValue({
          verdict: "approve",
          feedback: null,
          commentUrl: null,
          declaredAt: new Date().toISOString(),
        });

        // First commit (GATE_APPROVED) fails, second (ESCORT_DIED) succeeds
        mockPhaseTx.commit
          .mockReturnValueOnce({ success: false, error: "Rejected", code: "TRANSITION_REJECTED" })
          .mockReturnValueOnce({ success: true, fromPhase: "coding-gate", toPhase: "coding" });

        escortManager.onEscortExit(escortId!, 1);

        // Should have tried GATE_APPROVED first, then ESCORT_DIED
        expect(mockPhaseTx.commit).toHaveBeenCalledTimes(2);
        expect(mockPhaseTx.commit).toHaveBeenNthCalledWith(1, "ship-001", expect.objectContaining({
          event: { type: "GATE_APPROVED" },
        }));
        expect(mockPhaseTx.commit).toHaveBeenNthCalledWith(2, "ship-001", expect.objectContaining({
          event: expect.objectContaining({ type: "ESCORT_DIED" }),
        }));
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
    it("kills Escort process and marks DB record as done", async () => {
      const escortId = await escortManager.launchEscort("ship-001", "plan-gate");

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

  describe("cleanup/launch race prevention (#904)", () => {
    it("awaits pending cleanup before launching a new Escort", async () => {
      // Launch first Escort
      const firstId = await escortManager.launchEscort("ship-001", "plan-gate");
      expect(firstId).not.toBeNull();

      // Escort exits while in gate phase → triggers cleanup
      mockProcessManager.isRunning.mockReturnValue(false);
      mockDb.getShipById.mockReturnValue({
        ...makeShip(),
        phase: "plan-gate",
        issueTitle: "Test issue",
      });
      const mockActorManager = {
        requestTransition: vi.fn().mockReturnValue({ success: true, fromPhase: "plan-gate", toPhase: "plan" }),
        getPersistedSnapshot: vi.fn().mockReturnValue(null),
        getContext: vi.fn().mockReturnValue({ escortFailCount: 0 }),
        send: vi.fn(),
      };
      escortManager.setActorManager(mockActorManager as unknown as ConstructorParameters<typeof EscortManager>[0] extends infer T ? T extends { setActorManager: (a: infer A) => void } ? A : never : never);

      escortManager.onEscortExit(firstId!, 1);

      // Re-launch should succeed (cleanup awaited internally)
      mockDb.getEscortByShipId.mockReturnValue(undefined);
      mockDb.getShipById.mockReturnValue({ ...makeShip(), phase: "plan" });
      const secondId = await escortManager.launchEscort("ship-001", "plan-gate");
      expect(secondId).not.toBeNull();
    });

    it("falls back to fresh sortie when resume fails", async () => {
      // Simulate an existing Escort with sessionId
      mockDb.getEscortByShipId.mockReturnValue({
        id: "escort-001",
        shipId: "ship-001",
        sessionId: "bad-session",
        processPid: null,
        phase: "plan",
        createdAt: new Date().toISOString(),
        completedAt: null,
      });

      // Make resumeSession throw (simulating a corrupted session)
      mockProcessManager.resumeSession.mockImplementation(() => {
        throw new Error("Session not found");
      });

      const escortId = await escortManager.launchEscort("ship-001", "qa-gate");

      // Should have fallen back to sortie (fresh launch)
      expect(escortId).not.toBeNull();
      expect(mockProcessManager.sortie).toHaveBeenCalled();
      // Should have cleared the bad sessionId
      expect(mockDb.updateEscortSessionId).toHaveBeenCalledWith("escort-001", null);
    });
  });

  describe("stashForEscort / restoreFromEscortStash — CLAUDE.md handling", () => {
    it("stashes CLAUDE.md from worktree root during Escort launch", async () => {
      const { rename } = await import("node:fs/promises");

      await escortManager.launchEscort("ship-001", "plan-gate");

      // CLAUDE.md should be renamed from worktree root to .escort-stash/
      expect(rename).toHaveBeenCalledWith(
        "/repo/.worktrees/feature/42-test/CLAUDE.md",
        "/repo/.worktrees/feature/42-test/.claude/.escort-stash/CLAUDE.md",
      );
    });

    it("restores CLAUDE.md to worktree root after Escort exits", async () => {
      const { rename } = await import("node:fs/promises");

      const escortId = await escortManager.launchEscort("ship-001", "plan-gate");

      // Escort exits normally (phase already moved past gate)
      mockDb.getShipById.mockReturnValue({ ...makeShip(), phase: "coding" });
      escortManager.onEscortExit(escortId!, 0);

      // Wait for cleanup promise to resolve
      await new Promise((r) => setTimeout(r, 10));

      // CLAUDE.md should be renamed back from .escort-stash/ to worktree root
      expect(rename).toHaveBeenCalledWith(
        "/repo/.worktrees/feature/42-test/.claude/.escort-stash/CLAUDE.md",
        "/repo/.worktrees/feature/42-test/CLAUDE.md",
      );
    });
  });

  describe("killAll", () => {
    it("kills all running Escorts", async () => {
      // Launch two Escorts for different Ships
      mockShipManager.getShip
        .mockReturnValueOnce(makeShip({ id: "ship-001" }))
        .mockReturnValueOnce(makeShip({ id: "ship-002", issueNumber: 43 }));

      await escortManager.launchEscort("ship-001", "plan-gate");
      await escortManager.launchEscort("ship-002", "plan-gate");

      escortManager.killAll();

      expect(mockProcessManager.kill).toHaveBeenCalledTimes(2);
    });
  });
});
