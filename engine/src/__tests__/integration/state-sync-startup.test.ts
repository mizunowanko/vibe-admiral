import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock external I/O modules before importing StateSync
vi.mock("../../github.js", () => ({
  getIssue: vi.fn(),
  listIssues: vi.fn(),
  updateLabels: vi.fn(),
  closeIssue: vi.fn(),
  parseDependsOnLabels: vi.fn().mockReturnValue([]),
}));

vi.mock("../../worktree.js", () => ({
  getRepoRoot: vi.fn(),
  list: vi.fn(),
  listFeatureWorktrees: vi.fn(),
  remove: vi.fn(),
  forceRemove: vi.fn(),
}));

import { StateSync } from "../../state-sync.js";
import * as github from "../../github.js";
import * as worktree from "../../worktree.js";
import type { ShipProcess, Issue, Worktree, FleetRepo } from "../../types.js";

// === Mock types ===

type MockShipManager = {
  getShip: ReturnType<typeof vi.fn>;
  getAllShips: ReturnType<typeof vi.fn>;
  getShipsByFleet: ReturnType<typeof vi.fn>;
  getShipByIssue: ReturnType<typeof vi.fn>;
  getActiveShipIssueNumbers: ReturnType<typeof vi.fn>;
  hasRunningProcess: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
  purgeOrphanShips: ReturnType<typeof vi.fn>;
  restoreFromDisk: ReturnType<typeof vi.fn>;
};

type MockStatusManager = {
  getStatus: ReturnType<typeof vi.fn>;
  rollback: ReturnType<typeof vi.fn>;
  markDone: ReturnType<typeof vi.fn>;
};

function makeShip(overrides: Partial<ShipProcess> = {}): ShipProcess {
  return {
    id: "ship-1",
    fleetId: "fleet-1",
    repo: "owner/repo",
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

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 42,
    title: "Test",
    body: "",
    labels: [],
    state: "open",
    ...overrides,
  };
}

describe("StateSync startup reconciliation (integration)", () => {
  let stateSync: StateSync;
  let mockShipManager: MockShipManager;
  let mockStatusManager: MockStatusManager;

  beforeEach(() => {
    vi.clearAllMocks();

    mockShipManager = {
      getShip: vi.fn(),
      getAllShips: vi.fn().mockReturnValue([]),
      getShipsByFleet: vi.fn().mockReturnValue([]),
      getShipByIssue: vi.fn(),
      getActiveShipIssueNumbers: vi.fn().mockReturnValue([]),
      hasRunningProcess: vi.fn().mockReturnValue(false),
      updateStatus: vi.fn(),
      purgeOrphanShips: vi.fn().mockReturnValue(0),
      restoreFromDisk: vi.fn().mockResolvedValue(0),
    };
    mockStatusManager = {
      getStatus: vi.fn(),
      rollback: vi.fn().mockResolvedValue(undefined),
      markDone: vi.fn().mockResolvedValue(undefined),
    };

    stateSync = new StateSync(
      mockShipManager as unknown as ConstructorParameters<typeof StateSync>[0],
      mockStatusManager as unknown as ConstructorParameters<typeof StateSync>[1],
    );
  });

  describe("sortieGuard", () => {
    it("allows sortie when no duplicate ship exists and issue is in todo status", async () => {
      mockShipManager.getShipByIssue.mockReturnValue(undefined);
      mockStatusManager.getStatus.mockResolvedValue("todo");

      const result = await stateSync.sortieGuard("owner/repo", 42);
      expect(result.ok).toBe(true);
    });

    it("blocks sortie when a Ship already exists for this issue", async () => {
      mockShipManager.getShipByIssue.mockReturnValue(
        makeShip({ phase: "implementing" }),
      );

      const result = await stateSync.sortieGuard("owner/repo", 42);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("active Ship");
    });

    it("blocks sortie when issue has an active status label (doing)", async () => {
      mockShipManager.getShipByIssue.mockReturnValue(undefined);
      mockStatusManager.getStatus.mockResolvedValue("doing");

      const result = await stateSync.sortieGuard("owner/repo", 42);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("active status label");
    });

    it("blocks sortie when issue is already closed (done)", async () => {
      mockShipManager.getShipByIssue.mockReturnValue(undefined);
      mockStatusManager.getStatus.mockResolvedValue("done");

      const result = await stateSync.sortieGuard("owner/repo", 42);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("already closed");
    });

    it("allows sortie when issue has todo status", async () => {
      mockShipManager.getShipByIssue.mockReturnValue(undefined);
      mockStatusManager.getStatus.mockResolvedValue("todo");

      const result = await stateSync.sortieGuard("owner/repo", 42);
      expect(result.ok).toBe(true);
    });
  });

  describe("onProcessExit", () => {
    it("marks Ship as done on successful exit", async () => {
      const ship = makeShip({ phase: "merging" });
      mockShipManager.getShip.mockReturnValue(ship);
      vi.mocked(worktree.remove).mockResolvedValue(undefined);
      vi.mocked(worktree.getRepoRoot).mockResolvedValue("/repo");

      await stateSync.onProcessExit("ship-1", true);
      // First call is the immediate "done" update
      expect(mockShipManager.updateStatus).toHaveBeenCalledWith("ship-1", "done");
    });

    it("marks Ship as error and rollbacks label on failed exit", async () => {
      const ship = makeShip({ phase: "implementing" });
      mockShipManager.getShip.mockReturnValue(ship);
      // rescueIfAlreadyDone will call getIssue — issue is open, so not rescued
      vi.mocked(github.getIssue).mockResolvedValue(
        makeIssue({ number: 42, state: "open", labels: ["status/implementing"] }),
      );

      await stateSync.onProcessExit("ship-1", false);
      expect(mockShipManager.updateStatus).toHaveBeenCalledWith(
        "ship-1", "error", "Process exited",
      );
      // rollbackLabel delegates to rollback with default maxRetries=3
      expect(mockStatusManager.rollback).toHaveBeenCalledWith("owner/repo", 42, 3);
    });

    it("rescues Ship as done if issue is already closed on GitHub", async () => {
      const ship = makeShip({ phase: "implementing" });
      mockShipManager.getShip.mockReturnValue(ship);
      vi.mocked(github.getIssue).mockResolvedValue(
        makeIssue({ number: 42, state: "closed", labels: ["status/implementing"] }),
      );
      vi.mocked(github.updateLabels).mockResolvedValue(undefined);
      vi.mocked(worktree.remove).mockResolvedValue(undefined);
      vi.mocked(worktree.getRepoRoot).mockResolvedValue("/repo");

      await stateSync.onProcessExit("ship-1", false);
      // Should be rescued: first error, then done
      expect(mockShipManager.updateStatus).toHaveBeenCalledWith("ship-1", "done");
    });

    it("skips cleanup for unknown ships", async () => {
      mockShipManager.getShip.mockReturnValue(undefined);
      await stateSync.onProcessExit("unknown", false);
      expect(mockShipManager.updateStatus).not.toHaveBeenCalled();
    });
  });

  describe("reconcileOnStartup", () => {
    it("rolls back orphan status labels", async () => {
      const fleetRepos: FleetRepo[] = [
        { localPath: "/repo", remote: "owner/repo" },
      ];

      // Restore ships first
      mockShipManager.restoreFromDisk.mockResolvedValue(0);
      // No active ships — so any doing issue is orphaned
      mockShipManager.getActiveShipIssueNumbers.mockReturnValue([]);

      // Repo has an issue with status/implementing but no ship
      vi.mocked(github.listIssues).mockResolvedValue([
        makeIssue({ number: 50, labels: ["status/implementing"] }),
      ]);
      vi.mocked(worktree.getRepoRoot).mockResolvedValue("/repo");
      vi.mocked(worktree.listFeatureWorktrees).mockResolvedValue([]);

      await stateSync.reconcileOnStartup(fleetRepos);

      // rollbackLabel calls rollback with default maxRetries=3
      expect(mockStatusManager.rollback).toHaveBeenCalledWith("owner/repo", 50, 3);
    });

    it("removes orphan worktrees that have no active Ship", async () => {
      const fleetRepos: FleetRepo[] = [
        { localPath: "/repo", remote: "owner/repo" },
      ];

      mockShipManager.restoreFromDisk.mockResolvedValue(0);
      mockShipManager.getActiveShipIssueNumbers.mockReturnValue([]);

      vi.mocked(github.listIssues).mockResolvedValue([]);
      vi.mocked(worktree.getRepoRoot).mockResolvedValue("/repo");
      vi.mocked(worktree.listFeatureWorktrees).mockResolvedValue([
        { path: "/repo/.worktrees/feature/99-orphan", branch: "feature/99-orphan", head: "abc123" } as Worktree,
      ]);
      vi.mocked(worktree.remove).mockResolvedValue(undefined);

      await stateSync.reconcileOnStartup(fleetRepos);

      // removeWorktreeWithRetry resolves repoRoot then calls remove(path, repoRoot)
      expect(worktree.remove).toHaveBeenCalled();
      const removeCall = vi.mocked(worktree.remove).mock.calls[0];
      expect(removeCall![0]).toBe("/repo/.worktrees/feature/99-orphan");
    });

    it("preserves worktrees that have active Ships", async () => {
      const fleetRepos: FleetRepo[] = [
        { localPath: "/repo", remote: "owner/repo" },
      ];

      mockShipManager.restoreFromDisk.mockResolvedValue(1);
      mockShipManager.getActiveShipIssueNumbers.mockReturnValue([
        { repo: "owner/repo", issueNumber: 42 },
      ]);

      vi.mocked(github.listIssues).mockResolvedValue([]);
      vi.mocked(worktree.getRepoRoot).mockResolvedValue("/repo");
      vi.mocked(worktree.listFeatureWorktrees).mockResolvedValue([
        { path: "/repo/.worktrees/feature/42-test", branch: "feature/42-test", head: "abc123" } as Worktree,
      ]);

      await stateSync.reconcileOnStartup(fleetRepos);

      expect(worktree.remove).not.toHaveBeenCalled();
    });

    it("purges orphan ships", async () => {
      const fleetRepos: FleetRepo[] = [];

      mockShipManager.restoreFromDisk.mockResolvedValue(0);
      mockShipManager.getActiveShipIssueNumbers.mockReturnValue([]);

      await stateSync.reconcileOnStartup(fleetRepos);

      expect(mockShipManager.purgeOrphanShips).toHaveBeenCalled();
    });
  });

  describe("rollbackLabel", () => {
    it("delegates to StatusManager.rollback with default maxRetries", async () => {
      await stateSync.rollbackLabel("owner/repo", 42);
      // Default maxRetries = 3
      expect(mockStatusManager.rollback).toHaveBeenCalledWith("owner/repo", 42, 3);
    });

    it("passes custom maxRetries to StatusManager.rollback", async () => {
      await stateSync.rollbackLabel("owner/repo", 42, 5);
      expect(mockStatusManager.rollback).toHaveBeenCalledWith("owner/repo", 42, 5);
    });
  });
});
