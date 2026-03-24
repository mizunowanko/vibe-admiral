import { describe, expect, it, vi, beforeEach } from "vitest";
import { StateSync, ACTIVE_STATUS_LABELS } from "../state-sync.js";

// Mock external modules
vi.mock("../github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github.js")>();
  return {
    ...actual,
    getIssue: vi.fn(),
    updateLabels: vi.fn(),
    listIssues: vi.fn(),
  };
});

vi.mock("../worktree.js", () => ({
  getRepoRoot: vi.fn(),
  remove: vi.fn(),
  forceRemove: vi.fn(),
  listFeatureWorktrees: vi.fn(),
}));

import * as github from "../github.js";
import * as worktree from "../worktree.js";
import type { ShipProcess, Issue } from "../types.js";

const mockGetIssue = vi.mocked(github.getIssue);
const mockUpdateLabels = vi.mocked(github.updateLabels);
const mockListIssues = vi.mocked(github.listIssues);
const mockGetRepoRoot = vi.mocked(worktree.getRepoRoot);
const mockWorktreeRemove = vi.mocked(worktree.remove);
const mockForceRemove = vi.mocked(worktree.forceRemove);
const mockListFeatureWorktrees = vi.mocked(worktree.listFeatureWorktrees);

type MockShipManager = {
  getShipByIssue: ReturnType<typeof vi.fn>;
  getShip: ReturnType<typeof vi.fn>;
  updatePhase: ReturnType<typeof vi.fn>;
  notifyProcessDead: ReturnType<typeof vi.fn>;
  getActiveShipIssueNumbers: ReturnType<typeof vi.fn>;
  purgeOrphanShips: ReturnType<typeof vi.fn>;
  restoreFromDisk: ReturnType<typeof vi.fn>;
  hasRunningProcess: ReturnType<typeof vi.fn>;
  getAllShips: ReturnType<typeof vi.fn>;
  setIsCompacting: ReturnType<typeof vi.fn>;
  getLastStartedAt: ReturnType<typeof vi.fn>;
  incrementRapidDeathCount: ReturnType<typeof vi.fn>;
  resetRapidDeathCount: ReturnType<typeof vi.fn>;
  setPrUrl: ReturnType<typeof vi.fn>;
};

type MockStatusManager = {
  getStatus: ReturnType<typeof vi.fn>;
  markDone: ReturnType<typeof vi.fn>;
  rollback: ReturnType<typeof vi.fn>;
};

type MockEscortManager = {
  cleanupForDoneShip: ReturnType<typeof vi.fn>;
};

const REPO = "owner/repo";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    title: "Test",
    body: "",
    labels: [],
    state: "open",
    ...overrides,
  };
}

function makeShip(overrides: Partial<ShipProcess> = {}): ShipProcess {
  return {
    id: "ship-1",
    fleetId: "fleet-1",
    repo: REPO,
    issueNumber: 42,
    issueTitle: "Test",
    phase: "implementing",
    isCompacting: false,
    branchName: "feature/42-test",
    worktreePath: "/repo/.worktrees/feature/42-test",
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

describe("ACTIVE_STATUS_LABELS", () => {
  it("contains only status/sortied", () => {
    expect(ACTIVE_STATUS_LABELS.has("status/sortied")).toBe(true);
    expect(ACTIVE_STATUS_LABELS.size).toBe(1);
  });

  it("excludes legacy labels", () => {
    expect(ACTIVE_STATUS_LABELS.has("status/planning")).toBe(false);
    expect(ACTIVE_STATUS_LABELS.has("status/implementing")).toBe(false);
    expect(ACTIVE_STATUS_LABELS.has("status/merging")).toBe(false);
    expect(ACTIVE_STATUS_LABELS.has("status/ready")).toBe(false);
    expect(ACTIVE_STATUS_LABELS.has("status/mooring")).toBe(false);
  });
});

describe("StateSync", () => {
  let stateSync: StateSync;
  let mockShipManager: MockShipManager;
  let mockStatusManager: MockStatusManager;
  let mockEscortManager: MockEscortManager;

  beforeEach(() => {
    vi.clearAllMocks();

    mockShipManager = {
      getShipByIssue: vi.fn(),
      getShip: vi.fn(),
      updatePhase: vi.fn(),
      notifyProcessDead: vi.fn(),
      getActiveShipIssueNumbers: vi.fn().mockReturnValue([]),
      purgeOrphanShips: vi.fn(),
      restoreFromDisk: vi.fn().mockResolvedValue(0),
      hasRunningProcess: vi.fn().mockReturnValue(false),
      getAllShips: vi.fn().mockReturnValue([]),
      setIsCompacting: vi.fn(),
      getLastStartedAt: vi.fn().mockReturnValue(null),
      incrementRapidDeathCount: vi.fn().mockReturnValue(1),
      resetRapidDeathCount: vi.fn(),
      setPrUrl: vi.fn(),
    };
    mockStatusManager = {
      getStatus: vi.fn(),
      markDone: vi.fn(),
      rollback: vi.fn(),
    };
    mockEscortManager = {
      cleanupForDoneShip: vi.fn(),
    };
    stateSync = new StateSync(
      mockShipManager as unknown as ConstructorParameters<typeof StateSync>[0],
      mockStatusManager as unknown as ConstructorParameters<typeof StateSync>[1],
    );
    stateSync.setEscortManager(
      mockEscortManager as unknown as Parameters<typeof stateSync.setEscortManager>[0],
    );
  });

  describe("sortieGuard", () => {
    it("rejects if ship already exists for issue", async () => {
      mockShipManager.getShipByIssue.mockReturnValue(
        makeShip({ id: "existing" }),
      );
      const result = await stateSync.sortieGuard(REPO, 42);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("already has an active Ship");
    });

    it("rejects if issue is closed (done)", async () => {
      mockShipManager.getShipByIssue.mockReturnValue(undefined);
      mockStatusManager.getStatus.mockResolvedValue("done");
      const result = await stateSync.sortieGuard(REPO, 42);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("already closed");
    });

    it("rejects if issue already has active status (sortied)", async () => {
      mockShipManager.getShipByIssue.mockReturnValue(undefined);
      mockStatusManager.getStatus.mockResolvedValue("sortied");
      const result = await stateSync.sortieGuard(REPO, 42);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("already has an active status label");
    });

    it("allows sortie for ready issues", async () => {
      mockShipManager.getShipByIssue.mockReturnValue(undefined);
      mockStatusManager.getStatus.mockResolvedValue("ready");
      const result = await stateSync.sortieGuard(REPO, 42);
      expect(result).toEqual({ ok: true });
    });

    it("returns error when status check fails", async () => {
      mockShipManager.getShipByIssue.mockReturnValue(undefined);
      mockStatusManager.getStatus.mockRejectedValue(
        new Error("network error"),
      );
      const result = await stateSync.sortieGuard(REPO, 42);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("Failed to fetch issue");
    });
  });

  describe("removeWorktreeWithRetry", () => {
    it("succeeds on first attempt", async () => {
      mockGetRepoRoot.mockResolvedValue("/repo");
      mockWorktreeRemove.mockResolvedValue(undefined);

      await stateSync.removeWorktreeWithRetry("/repo/.worktrees/feature/42-test");
      expect(mockWorktreeRemove).toHaveBeenCalledTimes(1);
    });

    it("retries and succeeds on second attempt", async () => {
      mockGetRepoRoot.mockResolvedValue("/repo");
      mockWorktreeRemove
        .mockRejectedValueOnce(new Error("locked"))
        .mockResolvedValue(undefined);

      await stateSync.removeWorktreeWithRetry(
        "/repo/.worktrees/feature/42-test",
        1,
      );
      expect(mockWorktreeRemove).toHaveBeenCalledTimes(2);
    });

    it("falls back to forceRemove after exhausting retries", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      mockGetRepoRoot.mockResolvedValue("/repo");
      mockWorktreeRemove.mockRejectedValue(new Error("persistent error"));
      mockForceRemove.mockResolvedValue(undefined);

      await stateSync.removeWorktreeWithRetry(
        "/repo/.worktrees/feature/42-test",
        0,
      );
      expect(mockForceRemove).toHaveBeenCalledTimes(1);
      vi.mocked(console.warn).mockRestore();
    });
  });

  describe("onProcessExit", () => {
    it("handles successful exit: updates phase to done, removes worktree, marks done", async () => {
      const ship = makeShip();
      mockShipManager.getShip.mockReturnValue(ship);
      mockGetRepoRoot.mockResolvedValue("/repo");
      mockWorktreeRemove.mockResolvedValue(undefined);
      mockStatusManager.markDone.mockResolvedValue(undefined);

      await stateSync.onProcessExit("ship-1", true);

      expect(mockShipManager.updatePhase).toHaveBeenCalledWith(
        "ship-1",
        "done",
      );
      expect(mockWorktreeRemove).toHaveBeenCalled();
      expect(mockStatusManager.markDone).toHaveBeenCalledWith(REPO, 42);
    });

    it("handles failed exit with rescue (issue already closed)", async () => {
      const ship = makeShip();
      mockShipManager.getShip.mockReturnValue(ship);
      mockGetIssue.mockResolvedValue(
        makeIssue({ state: "closed", labels: ["status/sortied"] }),
      );
      mockGetRepoRoot.mockResolvedValue("/repo");
      mockWorktreeRemove.mockResolvedValue(undefined);
      mockUpdateLabels.mockResolvedValue(undefined);

      await stateSync.onProcessExit("ship-1", false);

      // Process dead notified first, then rescued to done
      expect(mockShipManager.notifyProcessDead).toHaveBeenCalledWith("ship-1");
      expect(mockShipManager.updatePhase).toHaveBeenCalledWith(
        "ship-1",
        "done",
      );
    });

    it("handles failed exit without rescue (issue still open)", async () => {
      const ship = makeShip();
      mockShipManager.getShip.mockReturnValue(ship);
      mockGetIssue.mockResolvedValue(makeIssue({ state: "open" }));
      mockStatusManager.rollback.mockResolvedValue(undefined);

      await stateSync.onProcessExit("ship-1", false);

      // Process dead notified (no "error" phase — derived state)
      expect(mockShipManager.notifyProcessDead).toHaveBeenCalledWith("ship-1");
      expect(mockStatusManager.rollback).toHaveBeenCalledWith(REPO, 42, 3);
    });

    it("clears isCompacting flag on exit", async () => {
      const ship = makeShip({ isCompacting: true });
      mockShipManager.getShip.mockReturnValue(ship);
      mockGetRepoRoot.mockResolvedValue("/repo");
      mockWorktreeRemove.mockResolvedValue(undefined);
      mockStatusManager.markDone.mockResolvedValue(undefined);

      await stateSync.onProcessExit("ship-1", true);
      expect(mockShipManager.setIsCompacting).toHaveBeenCalledWith("ship-1", false);
    });

    it("is a no-op when ship not found", async () => {
      mockShipManager.getShip.mockReturnValue(undefined);
      await stateSync.onProcessExit("unknown", true);
      expect(mockShipManager.updatePhase).not.toHaveBeenCalled();
    });

    it("cleans up Escort when parent Ship succeeds", async () => {
      const ship = makeShip();
      mockShipManager.getShip.mockReturnValue(ship);
      mockGetRepoRoot.mockResolvedValue("/repo");
      mockWorktreeRemove.mockResolvedValue(undefined);
      mockStatusManager.markDone.mockResolvedValue(undefined);

      await stateSync.onProcessExit("ship-1", true);

      expect(mockEscortManager.cleanupForDoneShip).toHaveBeenCalledWith("ship-1");
    });

    it("cleans up Escort when parent Ship is rescued (issue already closed)", async () => {
      const ship = makeShip();
      mockShipManager.getShip.mockReturnValue(ship);
      mockGetIssue.mockResolvedValue(
        makeIssue({ state: "closed", labels: ["status/sortied"] }),
      );
      mockGetRepoRoot.mockResolvedValue("/repo");
      mockWorktreeRemove.mockResolvedValue(undefined);
      mockUpdateLabels.mockResolvedValue(undefined);

      await stateSync.onProcessExit("ship-1", false);

      expect(mockEscortManager.cleanupForDoneShip).toHaveBeenCalledWith("ship-1");
    });

    it("does not clean up Escort on genuine failure", async () => {
      const ship = makeShip();
      mockShipManager.getShip.mockReturnValue(ship);
      mockGetIssue.mockResolvedValue(makeIssue({ state: "open" }));
      mockStatusManager.rollback.mockResolvedValue(undefined);

      await stateSync.onProcessExit("ship-1", false);

      expect(mockEscortManager.cleanupForDoneShip).not.toHaveBeenCalled();
    });
  });

  describe("auditDependencies", () => {
    it("removes resolved depends-on label from dependent issues", async () => {
      mockListIssues.mockResolvedValue([
        makeIssue({
          number: 50,
          labels: ["depends-on/42", "type/feature"],
        }),
      ]);
      mockUpdateLabels.mockResolvedValue(undefined);

      await stateSync.auditDependencies(REPO, 42);

      // Should remove the depends-on/42 label
      expect(mockUpdateLabels).toHaveBeenCalledWith(REPO, 50, {
        remove: "depends-on/42",
      });
    });

    it("does nothing when no issues have the label", async () => {
      mockListIssues.mockResolvedValue([]);

      await stateSync.auditDependencies(REPO, 42);

      expect(mockUpdateLabels).not.toHaveBeenCalled();
    });

    it("handles listIssues error gracefully (label may not exist)", async () => {
      mockListIssues.mockRejectedValue(new Error("label not found"));

      // Should not throw
      await stateSync.auditDependencies(REPO, 42);
    });
  });

  describe("reconcileOnStartup", () => {
    it("purges orphan ships first", async () => {
      await stateSync.reconcileOnStartup([]);
      expect(mockShipManager.purgeOrphanShips).toHaveBeenCalled();
    });

    it("rolls back orphan status labels", async () => {
      mockListIssues.mockImplementation(async (_repo, label) => {
        if (label === "status/sortied") {
          return [makeIssue({ number: 99, labels: ["status/sortied"] })];
        }
        return [];
      });
      mockGetRepoRoot.mockResolvedValue("/repo");
      mockListFeatureWorktrees.mockResolvedValue([]);
      mockStatusManager.rollback.mockResolvedValue(undefined);

      await stateSync.reconcileOnStartup([
        { remote: REPO, localPath: "/repo" },
      ]);

      expect(mockStatusManager.rollback).toHaveBeenCalledWith(REPO, 99, 3);
    });

    it("removes legacy labels (status/ready, status/mooring, etc.)", async () => {
      mockListIssues.mockImplementation(async (_repo, label) => {
        if (label === "status/ready") {
          return [makeIssue({ number: 88, labels: ["status/ready"] })];
        }
        return [];
      });
      mockGetRepoRoot.mockResolvedValue("/repo");
      mockListFeatureWorktrees.mockResolvedValue([]);
      mockUpdateLabels.mockResolvedValue(undefined);

      await stateSync.reconcileOnStartup([
        { remote: REPO, localPath: "/repo" },
      ]);

      expect(mockUpdateLabels).toHaveBeenCalledWith(REPO, 88, {
        remove: "status/ready",
      });
    });

    it("does not roll back labels for active ships", async () => {
      mockShipManager.getActiveShipIssueNumbers.mockReturnValue([
        { repo: REPO, issueNumber: 42 },
      ]);
      mockListIssues.mockImplementation(async (_repo, label) => {
        if (label === "status/sortied") {
          return [makeIssue({ number: 42, labels: ["status/sortied"] })];
        }
        return [];
      });
      mockGetRepoRoot.mockResolvedValue("/repo");
      mockListFeatureWorktrees.mockResolvedValue([]);

      await stateSync.reconcileOnStartup([
        { remote: REPO, localPath: "/repo" },
      ]);

      expect(mockStatusManager.rollback).not.toHaveBeenCalled();
    });

    it("removes orphan feature worktrees", async () => {
      mockListIssues.mockResolvedValue([]);
      mockGetRepoRoot.mockResolvedValue("/repo");
      mockListFeatureWorktrees.mockResolvedValue([
        {
          path: "/repo/.worktrees/feature/99-orphan",
          branch: "feature/99-orphan",
          head: "abc",
        },
      ]);
      mockWorktreeRemove.mockResolvedValue(undefined);

      await stateSync.reconcileOnStartup([
        { remote: REPO, localPath: "/repo" },
      ]);

      expect(mockWorktreeRemove).toHaveBeenCalled();
    });

    it("skips repos without remote", async () => {
      await stateSync.reconcileOnStartup([{ localPath: "/repo" }]);
      expect(mockListIssues).not.toHaveBeenCalled();
    });
  });
});
