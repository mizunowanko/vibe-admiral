/**
 * Ship lifecycle integration tests.
 *
 * Tests the ShipManager with a real SQLite database and mocked external I/O
 * (ProcessManager, StatusManager, GitHub, worktree). This validates the
 * critical paths: sortie flow, phase transitions, gate checks, retry logic,
 * and DB persistence — all wired together.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock external I/O before imports
vi.mock("../../github.js", () => ({
  getIssue: vi.fn().mockResolvedValue({
    number: 42,
    title: "Test issue",
    body: "Test body",
    labels: ["type/feature"],
    state: "open",
  }),
  getDefaultBranch: vi.fn().mockResolvedValue("main"),
}));

vi.mock("../../worktree.js", () => ({
  getRepoRoot: vi.fn().mockResolvedValue("/repo"),
  create: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
  symlinkSettings: vi.fn().mockResolvedValue(undefined),
  toKebabCase: vi.fn().mockReturnValue("test-issue"),
  isWebProject: vi.fn().mockResolvedValue(false),
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn().mockImplementation(() => {
    const EventEmitter = require("node:events").EventEmitter;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const proc = new EventEmitter();
    proc.stdout = stdout;
    proc.stderr = stderr;
    proc.stdin = null;
    proc.pid = 12345;
    proc.exitCode = null;
    proc.kill = vi.fn();
    return proc;
  }),
  execFile: vi.fn((_cmd: string, _args: unknown, _opts: unknown, ...rest: unknown[]) => {
    const cb = typeof _opts === "function" ? _opts : rest[0];
    if (typeof cb === "function") {
      (cb as (err: null, result: { stdout: string }) => void)(null, { stdout: "" });
    }
    return undefined;
  }),
}));

import { FleetDatabase } from "../../db.js";
import { ShipManager } from "../../ship-manager.js";
import { ProcessManager } from "../../process-manager.js";
import * as github from "../../github.js";
import * as worktree from "../../worktree.js";
import type { ShipProcess, Phase } from "../../types.js";

type MockStatusManager = {
  markSortied: ReturnType<typeof vi.fn>;
  rollback: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
};

function makeShip(overrides: Partial<ShipProcess> = {}): ShipProcess {
  return {
    id: "ship-001",
    fleetId: "fleet-1",
    repo: "owner/repo",
    issueNumber: 42,
    issueTitle: "Test issue",
    phase: "plan",
    isCompacting: false,
    branchName: "feature/42-test-issue",
    worktreePath: "/repo/.worktrees/feature/42-test-issue",
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

describe("Ship lifecycle (integration)", () => {
  let db: FleetDatabase;
  let tmpDir: string;
  let shipManager: ShipManager;
  let processManager: ProcessManager;
  let mockStatusManager: MockStatusManager;
  let phaseChanges: Array<{ id: string; phase: Phase; detail?: string }>;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await mkdtemp(join(tmpdir(), "ship-lifecycle-test-"));
    db = new FleetDatabase(join(tmpDir, "test.db"));

    // Create a skills directory structure for deploySkills
    const skillsDir = join(tmpDir, "skills", "implement");
    await mkdir(skillsDir, { recursive: true });
    await writeFile(join(skillsDir, "SKILL.md"), "# implement skill");

    processManager = new ProcessManager();
    mockStatusManager = {
      markSortied: vi.fn(),
      rollback: vi.fn(),
      getStatus: vi.fn().mockResolvedValue("ready"),
    };

    shipManager = new ShipManager(
      processManager,
      mockStatusManager as unknown as ConstructorParameters<typeof ShipManager>[1],
    );
    shipManager.setDatabase(db);

    phaseChanges = [];
    shipManager.setPhaseChangeHandler((id, phase, detail) => {
      phaseChanges.push({ id, phase, detail });
    });
  });

  afterEach(async () => {
    processManager.killAll();
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("sortie flow", () => {
    it("creates a Ship with DB persistence, then launches process", async () => {
      // Set up worktree mock to return our tmpDir as repo root
      vi.mocked(worktree.getRepoRoot).mockResolvedValue(tmpDir);

      const ship = await shipManager.sortie(
        "fleet-1",
        "owner/repo",
        42,
        tmpDir,
      );

      // Ship should be created with correct data
      expect(ship.fleetId).toBe("fleet-1");
      expect(ship.repo).toBe("owner/repo");
      expect(ship.issueNumber).toBe(42);
      expect(ship.issueTitle).toBe("Test issue");
      expect(ship.phase).toBe("plan");
      expect(ship.branchName).toBe("feature/42-test-issue");

      // Ship should be persisted in DB
      const dbShip = db.getShipById(ship.id);
      expect(dbShip).toBeDefined();
      expect(dbShip!.issueNumber).toBe(42);

      // StatusManager should have been called
      expect(mockStatusManager.markSortied).toHaveBeenCalledWith("owner/repo", 42);

      // Worktree should have been created
      expect(worktree.create).toHaveBeenCalled();
    });

    it("persists to DB before spawning process (order guarantee)", async () => {
      vi.mocked(worktree.getRepoRoot).mockResolvedValue(tmpDir);

      const callOrder: string[] = [];
      const originalUpsertShip = db.upsertShip.bind(db);
      vi.spyOn(db, "upsertShip").mockImplementation((ship) => {
        callOrder.push("db-insert");
        return originalUpsertShip(ship);
      });

      const { spawn } = await import("node:child_process");
      vi.mocked(spawn).mockImplementation((..._args: unknown[]) => {
        callOrder.push("process-spawn");
        const EventEmitter = require("node:events").EventEmitter;
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.stdin = null;
        proc.pid = 12345;
        proc.exitCode = null;
        proc.kill = vi.fn();
        return proc as unknown as ReturnType<typeof spawn>;
      });

      await shipManager.sortie("fleet-1", "owner/repo", 42, tmpDir);

      // DB insert must happen before process spawn (#471)
      expect(callOrder.indexOf("db-insert")).toBeLessThan(
        callOrder.indexOf("process-spawn"),
      );
    });

    it("cleans up done/stopped ships on new sortie", async () => {
      vi.mocked(worktree.getRepoRoot).mockResolvedValue(tmpDir);

      // Pre-populate DB with a done ship
      db.upsertShip(makeShip({ id: "old-ship", phase: "done" }));
      expect(db.getShipById("old-ship")).toBeDefined();

      await shipManager.sortie("fleet-1", "owner/repo", 42, tmpDir);

      // Old done ship should be cleaned up
      expect(db.getShipById("old-ship")).toBeUndefined();
    });

    it("rolls back worktree if DB insert fails", async () => {
      vi.mocked(worktree.getRepoRoot).mockResolvedValue(tmpDir);

      // Make upsertShip throw
      vi.spyOn(db, "upsertShip").mockImplementation(() => {
        throw new Error("DB write failed");
      });

      await expect(
        shipManager.sortie("fleet-1", "owner/repo", 42, tmpDir),
      ).rejects.toThrow("Failed to persist ship to DB");

      // Worktree should be cleaned up
      expect(worktree.remove).toHaveBeenCalled();
    });
  });

  describe("phase transitions", () => {
    let shipId: string;

    beforeEach(async () => {
      vi.mocked(worktree.getRepoRoot).mockResolvedValue(tmpDir);
      const ship = await shipManager.sortie("fleet-1", "owner/repo", 42, tmpDir);
      shipId = ship.id;
      phaseChanges.length = 0; // Clear initial phase change
    });

    it("updatePhase changes phase in DB and notifies handler", () => {
      shipManager.updatePhase(shipId, "coding");

      const ship = shipManager.getShip(shipId);
      expect(ship!.phase).toBe("coding");

      // Handler should be notified
      expect(phaseChanges).toHaveLength(1);
      expect(phaseChanges[0]!.phase).toBe("coding");
    });

    it("does not notify when phase doesn't change", () => {
      // Phase is already "plan" from sortie
      shipManager.updatePhase(shipId, "plan");

      expect(phaseChanges).toHaveLength(0);
    });

    it("records phase transition in audit log", () => {
      shipManager.updatePhase(shipId, "plan-gate");

      // Check phase_transitions table directly
      const raw = db["db"].prepare(
        "SELECT from_phase, to_phase FROM phase_transitions WHERE ship_id = ?",
      ).all(shipId) as Array<{ from_phase: string; to_phase: string }>;

      // Should have the transition from plan to plan-gate
      const transition = raw.find((r) => r.to_phase === "plan-gate");
      expect(transition).toBeDefined();
      expect(transition!.from_phase).toBe("plan");
    });

    it("sets completedAt timestamp when phase becomes done", () => {
      shipManager.updatePhase(shipId, "done");

      const ship = db.getShipById(shipId);
      expect(ship!.completedAt).toBeDefined();
      expect(ship!.completedAt).toBeGreaterThan(0);
    });

    it("syncPhaseFromDb reads DB and notifies without writing", () => {
      // Directly update DB (simulate REST API transition)
      db.updateShipPhase(shipId, "coding");

      shipManager.syncPhaseFromDb(shipId);

      expect(phaseChanges).toHaveLength(1);
      expect(phaseChanges[0]!.phase).toBe("coding");
    });
  });

  describe("gate check management", () => {
    let shipId: string;

    beforeEach(async () => {
      vi.mocked(worktree.getRepoRoot).mockResolvedValue(tmpDir);
      const ship = await shipManager.sortie("fleet-1", "owner/repo", 42, tmpDir);
      shipId = ship.id;
    });

    it("setGateCheck stores pending gate state in runtime", () => {
      shipManager.setGateCheck(shipId, "plan-gate", "plan-review");

      const ship = shipManager.getShip(shipId);
      expect(ship!.gateCheck).not.toBeNull();
      expect(ship!.gateCheck!.gatePhase).toBe("plan-gate");
      expect(ship!.gateCheck!.gateType).toBe("plan-review");
      expect(ship!.gateCheck!.status).toBe("pending");
    });

    it("clearGateCheck removes gate state", () => {
      shipManager.setGateCheck(shipId, "plan-gate", "plan-review");
      shipManager.clearGateCheck(shipId);

      const ship = shipManager.getShip(shipId);
      expect(ship!.gateCheck).toBeNull();
    });
  });

  describe("runtime state management", () => {
    let shipId: string;

    beforeEach(async () => {
      vi.mocked(worktree.getRepoRoot).mockResolvedValue(tmpDir);
      const ship = await shipManager.sortie("fleet-1", "owner/repo", 42, tmpDir);
      shipId = ship.id;
    });

    it("setIsCompacting updates runtime-only state", () => {
      shipManager.setIsCompacting(shipId, true);
      expect(shipManager.getShip(shipId)!.isCompacting).toBe(true);

      shipManager.setIsCompacting(shipId, false);
      expect(shipManager.getShip(shipId)!.isCompacting).toBe(false);
    });

    it("setLastOutputAt updates runtime-only timestamp", () => {
      const now = Date.now();
      shipManager.setLastOutputAt(shipId, now);
      expect(shipManager.getShip(shipId)!.lastOutputAt).toBe(now);
    });

    it("setSessionId updates DB", () => {
      shipManager.setSessionId(shipId, "sess-abc");
      const dbShip = db.getShipById(shipId);
      expect(dbShip!.sessionId).toBe("sess-abc");
    });

    it("setPrUrl updates DB", () => {
      shipManager.setPrUrl(shipId, "https://github.com/owner/repo/pull/99");
      const dbShip = db.getShipById(shipId);
      expect(dbShip!.prUrl).toBe("https://github.com/owner/repo/pull/99");
    });

    it("setQaRequired updates DB", () => {
      shipManager.setQaRequired(shipId, false);
      const dbShip = db.getShipById(shipId);
      expect(dbShip!.qaRequired).toBe(false);
    });

    it("respondToPRReview updates runtime review status", () => {
      shipManager.respondToPRReview(shipId, { verdict: "approve" });
      expect(shipManager.getShip(shipId)!.prReviewStatus).toBe("approved");

      shipManager.respondToPRReview(shipId, { verdict: "request-changes", comments: "Fix X" });
      expect(shipManager.getShip(shipId)!.prReviewStatus).toBe("changes-requested");
    });
  });

  describe("notifyProcessDead", () => {
    let shipId: string;

    beforeEach(async () => {
      vi.mocked(worktree.getRepoRoot).mockResolvedValue(tmpDir);
      const ship = await shipManager.sortie("fleet-1", "owner/repo", 42, tmpDir);
      shipId = ship.id;
      phaseChanges.length = 0;
    });

    it("sets processDead flag and triggers notification without changing phase", () => {
      shipManager.notifyProcessDead(shipId);

      const ship = shipManager.getShip(shipId);
      expect(ship!.processDead).toBe(true);

      // Phase should remain unchanged
      expect(ship!.phase).toBe("plan");

      // Should trigger notification with "Process dead" detail
      expect(phaseChanges).toHaveLength(1);
      expect(phaseChanges[0]!.detail).toBe("Process dead");
    });
  });

  describe("stopShip", () => {
    let shipId: string;

    beforeEach(async () => {
      vi.mocked(worktree.getRepoRoot).mockResolvedValue(tmpDir);
      const ship = await shipManager.sortie("fleet-1", "owner/repo", 42, tmpDir);
      shipId = ship.id;
      phaseChanges.length = 0;
    });

    it("kills process and transitions to stopped phase", () => {
      const result = shipManager.stopShip(shipId);

      expect(result).toBe(true);
      const ship = shipManager.getShip(shipId);
      expect(ship!.phase).toBe("stopped");
    });
  });

  describe("retryShip", () => {
    let shipId: string;

    beforeEach(async () => {
      vi.mocked(worktree.getRepoRoot).mockResolvedValue(tmpDir);
      const ship = await shipManager.sortie("fleet-1", "owner/repo", 42, tmpDir);
      shipId = ship.id;
      phaseChanges.length = 0;
    });

    it("returns null if ship is in done phase", () => {
      shipManager.updatePhase(shipId, "done");
      expect(shipManager.retryShip(shipId)).toBeNull();
    });

    it("returns null if process is still running", () => {
      // Process is running (default mock returns true for isRunning)
      expect(shipManager.retryShip(shipId)).toBeNull();
    });

    it("re-sorties from scratch when no sessionId exists", () => {
      // Simulate process death
      processManager.kill(shipId);

      const retried = shipManager.retryShip(shipId);
      expect(retried).not.toBeNull();
      expect(retried!.retryCount).toBe(1);
    });

    it("resumes session when sessionId is available", () => {
      shipManager.setSessionId(shipId, "sess-existing");
      processManager.kill(shipId);

      const retried = shipManager.retryShip(shipId);
      expect(retried).not.toBeNull();
    });

    it("increments retry count on each retry", () => {
      processManager.kill(shipId);

      shipManager.retryShip(shipId);
      let ship = shipManager.getShip(shipId);
      expect(ship!.retryCount).toBe(1);

      processManager.kill(shipId);
      shipManager.retryShip(shipId);
      ship = shipManager.getShip(shipId);
      expect(ship!.retryCount).toBe(2);
    });

    it("preserves current phase for non-stopped process-dead ship with session (#689)", () => {
      // Ship is in "plan" phase (initial), set sessionId, kill process
      shipManager.setSessionId(shipId, "sess-plan");
      processManager.kill(shipId);

      // retryShip should preserve "plan", NOT fall back to "coding"
      const retried = shipManager.retryShip(shipId);
      expect(retried).not.toBeNull();
      const ship = shipManager.getShip(shipId);
      expect(ship!.phase).toBe("plan");
    });

    it("sends ship:updated notification even when phase does not change (#683)", () => {
      // Simulate: ship is in "coding" phase but process died
      shipManager.updatePhase(shipId, "coding");
      processManager.kill(shipId);
      shipManager.notifyProcessDead(shipId);
      phaseChanges.length = 0; // clear previous notifications

      // Resume the ship — phase stays "coding" but processDead changes
      shipManager.retryShip(shipId);

      // Should have at least one notification with "Ship resumed"
      const resumeNotification = phaseChanges.find(
        (c) => c.detail === "Ship resumed",
      );
      expect(resumeNotification).toBeDefined();
      expect(resumeNotification!.phase).toBe("coding");

      // processDead should be cleared
      const ship = shipManager.getShip(shipId);
      expect(ship!.processDead).toBe(false);
    });
  });

  describe("ship queries", () => {
    beforeEach(async () => {
      vi.mocked(worktree.getRepoRoot).mockResolvedValue(tmpDir);
    });

    it("getAllShips returns all ships with runtime state merged", async () => {
      const ship = await shipManager.sortie("fleet-1", "owner/repo", 42, tmpDir);
      shipManager.setIsCompacting(ship.id, true);

      const all = shipManager.getAllShips();
      expect(all).toHaveLength(1);
      expect(all[0]!.isCompacting).toBe(true);
    });

    it("getShipsByFleet filters by fleet ID", async () => {
      vi.mocked(github.getIssue)
        .mockResolvedValueOnce({ number: 42, title: "Issue 42", body: "", labels: [], state: "open" })
        .mockResolvedValueOnce({ number: 43, title: "Issue 43", body: "", labels: [], state: "open" });

      await shipManager.sortie("fleet-1", "owner/repo", 42, tmpDir);
      await shipManager.sortie("fleet-2", "owner/repo", 43, tmpDir);

      const fleet1Ships = shipManager.getShipsByFleet("fleet-1");
      expect(fleet1Ships).toHaveLength(1);
      expect(fleet1Ships[0]!.issueNumber).toBe(42);
    });

    it("getShipByIssue finds ship by repo and issue number", async () => {
      await shipManager.sortie("fleet-1", "owner/repo", 42, tmpDir);

      const found = shipManager.getShipByIssue("owner/repo", 42);
      expect(found).toBeDefined();
      expect(found!.issueNumber).toBe(42);

      expect(shipManager.getShipByIssue("owner/repo", 999)).toBeUndefined();
    });

    it("resolveShip supports prefix matching", async () => {
      const ship = await shipManager.sortie("fleet-1", "owner/repo", 42, tmpDir);
      const prefix = ship.id.slice(0, 8);

      const resolved = shipManager.resolveShip(prefix);
      expect(resolved).toBeDefined();
      expect(resolved!.id).toBe(ship.id);
    });

    it("getActiveShipIssueNumbers returns active ships only", async () => {
      await shipManager.sortie("fleet-1", "owner/repo", 42, tmpDir);

      const active = shipManager.getActiveShipIssueNumbers();
      expect(active).toHaveLength(1);
      expect(active[0]).toEqual({ repo: "owner/repo", issueNumber: 42 });
    });
  });

  describe("restoreFromDisk", () => {
    it("restores active ships from DB and creates runtime entries", async () => {
      // Pre-populate DB with an active ship
      db.upsertShip(makeShip({ id: "restored-ship", phase: "coding" }));

      const restored = await shipManager.restoreFromDisk();
      expect(restored).toBe(1);

      const ship = shipManager.getShip("restored-ship");
      expect(ship).toBeDefined();
      expect(ship!.phase).toBe("coding");
    });

    it("skips ships that already have runtime entries", async () => {
      vi.mocked(worktree.getRepoRoot).mockResolvedValue(tmpDir);
      await shipManager.sortie("fleet-1", "owner/repo", 42, tmpDir);

      // restoreFromDisk should not duplicate the runtime entry
      const restored = await shipManager.restoreFromDisk();
      expect(restored).toBe(0);
    });
  });

  describe("purgeOrphanShips", () => {
    it("removes done ships with no running process", async () => {
      db.upsertShip(makeShip({ id: "orphan-ship", phase: "done" }));

      const purged = shipManager.purgeOrphanShips();
      expect(purged).toBe(1);
      expect(db.getShipById("orphan-ship")).toBeUndefined();
    });

    it("does not purge active ships", async () => {
      db.upsertShip(makeShip({ id: "active-ship", phase: "coding" }));

      const purged = shipManager.purgeOrphanShips();
      expect(purged).toBe(0);
      expect(db.getShipById("active-ship")).toBeDefined();
    });
  });
});
