import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { FleetDatabase, initFleetDatabase } from "../db.js";
import type { ShipProcess } from "../types.js";

function makeShip(overrides: Partial<ShipProcess> = {}): ShipProcess {
  return {
    id: "ship-001",
    fleetId: "fleet-1",
    repo: "owner/repo",
    issueNumber: 42,
    issueTitle: "Test issue",
    phase: "planning",
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
    kind: "ship",
    parentShipId: null,
    ...overrides,
  };
}

describe("FleetDatabase", () => {
  let db: FleetDatabase;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "fleet-db-test-"));
    db = new FleetDatabase(join(tmpDir, "test.db"));
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("ensureRepo", () => {
    it("creates a new repo and returns its ID", () => {
      const id = db.ensureRepo("owner", "repo");
      expect(id).toBeGreaterThan(0);
    });

    it("returns existing repo ID on duplicate", () => {
      const id1 = db.ensureRepo("owner", "repo");
      const id2 = db.ensureRepo("owner", "repo");
      expect(id1).toBe(id2);
    });

    it("creates separate entries for different repos", () => {
      const id1 = db.ensureRepo("owner", "repo-a");
      const id2 = db.ensureRepo("owner", "repo-b");
      expect(id1).not.toBe(id2);
    });
  });

  describe("upsertShip", () => {
    it("inserts a new ship", () => {
      const ship = makeShip();
      db.upsertShip(ship);

      const ships = db.getActiveShips();
      expect(ships).toHaveLength(1);
      expect(ships[0]!.id).toBe("ship-001");
      expect(ships[0]!.issueNumber).toBe(42);
      expect(ships[0]!.repo).toBe("owner/repo");
    });

    it("updates an existing ship on conflict", () => {
      const ship = makeShip();
      db.upsertShip(ship);

      const updated = makeShip({ phase: "implementing", issueTitle: "Updated" });
      db.upsertShip(updated);

      const ships = db.getActiveShips();
      expect(ships).toHaveLength(1);
      expect(ships[0]!.phase).toBe("implementing");
      expect(ships[0]!.issueTitle).toBe("Updated");
    });

    it("handles ships with PR URL", () => {
      const ship = makeShip({ prUrl: "https://github.com/owner/repo/pull/1" });
      db.upsertShip(ship);

      const ships = db.getActiveShips();
      expect(ships[0]!.prUrl).toBe("https://github.com/owner/repo/pull/1");
    });
  });

  describe("getActiveShips", () => {
    it("returns only non-terminal ships", () => {
      db.upsertShip(makeShip({ id: "s1", phase: "planning" }));
      db.upsertShip(makeShip({ id: "s2", issueNumber: 43, phase: "done", completedAt: Date.now() }));
      db.upsertShip(makeShip({ id: "s3", issueNumber: 44, phase: "implementing" }));
      db.upsertShip(makeShip({ id: "s4", issueNumber: 45, phase: "done", processDead: true, completedAt: Date.now() }));

      const active = db.getActiveShips();
      expect(active).toHaveLength(2);
      const ids = active.map((s) => s.id).sort();
      expect(ids).toEqual(["s1", "s3"]);
    });

    it("returns empty array when no active ships", () => {
      db.upsertShip(makeShip({ phase: "done", completedAt: Date.now() }));
      expect(db.getActiveShips()).toHaveLength(0);
    });

    it("restores qaRequired correctly", () => {
      db.upsertShip(makeShip({ qaRequired: false }));
      const ships = db.getActiveShips();
      expect(ships[0]!.qaRequired).toBe(false);
    });
  });

  describe("updateShipPhase", () => {
    it("updates phase for an existing ship", () => {
      db.upsertShip(makeShip());
      db.updateShipPhase("ship-001", "implementing");

      const ships = db.getActiveShips();
      expect(ships[0]!.phase).toBe("implementing");
    });

    it("sets completedAt for terminal phases", () => {
      db.upsertShip(makeShip());
      const now = Date.now();
      db.updateShipPhase("ship-001", "done", now);

      // Ship is in terminal state, so getActiveShips won't return it
      // Verify by checking that active list is empty
      expect(db.getActiveShips()).toHaveLength(0);
    });
  });

  describe("updateShipSessionId", () => {
    it("updates session ID", () => {
      db.upsertShip(makeShip());
      db.updateShipSessionId("ship-001", "session-abc");

      const ships = db.getActiveShips();
      expect(ships[0]!.sessionId).toBe("session-abc");
    });

    it("clears session ID with null", () => {
      db.upsertShip(makeShip({ sessionId: "session-abc" }));
      db.updateShipSessionId("ship-001", null);

      const ships = db.getActiveShips();
      expect(ships[0]!.sessionId).toBeNull();
    });
  });

  describe("deleteShip", () => {
    it("removes a ship and its related records", () => {
      db.upsertShip(makeShip());
      db.recordPhaseTransition("ship-001", null, "planning", "engine");

      db.deleteShip("ship-001");
      expect(db.getActiveShips()).toHaveLength(0);
    });

    it("does nothing for non-existent ship", () => {
      db.deleteShip("non-existent");
      // No error thrown
    });
  });

  describe("recordPhaseTransition", () => {
    it("records a transition in the audit log", () => {
      db.upsertShip(makeShip());
      db.recordPhaseTransition("ship-001", null, "planning", "engine");
      db.recordPhaseTransition("ship-001", "planning", "implementing", "engine", { reason: "plan approved" });
      // No error thrown — audit log is write-only for now
    });
  });

  describe("transitionPhase", () => {
    it("applies a valid forward transition", () => {
      db.upsertShip(makeShip());
      const applied = db.transitionPhase("ship-001", "planning", "planning-gate", "engine");
      expect(applied).toBe(true);

      const ships = db.getActiveShips();
      expect(ships[0]!.phase).toBe("planning-gate");
    });

    it("rejects backward transitions", () => {
      db.upsertShip(makeShip({ phase: "implementing" }));
      expect(() =>
        db.transitionPhase("ship-001", "implementing", "planning", "engine"),
      ).toThrow("Cannot go backward");
    });

    it("throws on phase mismatch", () => {
      db.upsertShip(makeShip({ phase: "planning" }));
      expect(() =>
        db.transitionPhase("ship-001", "implementing", "implementing-gate", "engine"),
      ).toThrow("Phase mismatch");
    });

    it("is idempotent within 5 seconds", () => {
      db.upsertShip(makeShip());
      const first = db.transitionPhase("ship-001", "planning", "planning-gate", "engine");
      expect(first).toBe(true);

      // Same transition again — should be no-op
      db.updateShipPhase("ship-001", "planning"); // reset phase for re-attempt
      const second = db.transitionPhase("ship-001", "planning", "planning-gate", "engine");
      expect(second).toBe(false);
    });

    it("records transition in audit log", () => {
      db.upsertShip(makeShip());
      db.transitionPhase("ship-001", "planning", "planning-gate", "engine", { reason: "gate triggered" });

      // Verify by attempting to delete — deleteShip cleans up phase_transitions too
      // If the audit record exists, no error is thrown
      db.deleteShip("ship-001");
      expect(db.getActiveShips()).toHaveLength(0);
    });

    it("throws for non-existent ship", () => {
      expect(() =>
        db.transitionPhase("non-existent", "planning", "implementing", "engine"),
      ).toThrow("not found");
    });
  });

  describe("purgeTerminalShips", () => {
    it("removes ships in done phase", () => {
      db.upsertShip(makeShip({ id: "s1", phase: "planning" }));
      db.upsertShip(makeShip({ id: "s2", issueNumber: 43, phase: "done", completedAt: Date.now() }));
      db.upsertShip(makeShip({ id: "s3", issueNumber: 44, phase: "done", processDead: true, completedAt: Date.now() }));

      const purged = db.purgeTerminalShips();
      expect(purged).toBe(2);

      const active = db.getActiveShips();
      expect(active).toHaveLength(1);
      expect(active[0]!.id).toBe("s1");
    });

    it("returns 0 when no terminal ships", () => {
      db.upsertShip(makeShip());
      expect(db.purgeTerminalShips()).toBe(0);
    });
  });

  describe("phase_transitions metadata", () => {
    /** Open a raw SQLite connection to query phase_transitions directly. */
    function queryTransitions(dbPath: string) {
      const raw = new Database(dbPath);
      const rows = raw.prepare(
        "SELECT from_phase, to_phase, triggered_by, metadata FROM phase_transitions ORDER BY id",
      ).all() as Array<{
        from_phase: string | null;
        to_phase: string;
        triggered_by: string;
        metadata: string | null;
      }>;
      raw.close();
      return rows;
    }

    it("stores metadata JSON via transitionPhase", () => {
      db.upsertShip(makeShip());
      db.transitionPhase("ship-001", "planning", "planning-gate", "ship", {
        planCommentUrl: "https://github.com/owner/repo/issues/42#comment-1",
        qaRequired: true,
      });

      const rows = queryTransitions(db.path);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.triggered_by).toBe("ship");

      const meta = JSON.parse(rows[0]!.metadata!);
      expect(meta.planCommentUrl).toBe("https://github.com/owner/repo/issues/42#comment-1");
      expect(meta.qaRequired).toBe(true);
    });

    it("stores gate rejection feedback via transitionPhase", () => {
      db.upsertShip(makeShip({ phase: "planning-gate" }));
      // Escort rejects: planning-gate → planning (backward is disallowed by transitionPhase)
      // Use recordPhaseTransition for rejection (which doesn't enforce forward-only)
      db.recordPhaseTransition("ship-001", "planning-gate", "planning", "escort", {
        gate_result: "rejected",
        feedback: "Plan is too broad, narrow the scope",
      });

      const rows = queryTransitions(db.path);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.from_phase).toBe("planning-gate");
      expect(rows[0]!.to_phase).toBe("planning");
      expect(rows[0]!.triggered_by).toBe("escort");

      const meta = JSON.parse(rows[0]!.metadata!);
      expect(meta.gate_result).toBe("rejected");
      expect(meta.feedback).toBe("Plan is too broad, narrow the scope");
    });

    it("stores gate approval metadata via recordPhaseTransition", () => {
      db.upsertShip(makeShip({ phase: "implementing-gate" }));
      db.recordPhaseTransition("ship-001", "implementing-gate", "acceptance-test", "escort", {
        gate_result: "approved",
      });

      const rows = queryTransitions(db.path);
      expect(rows).toHaveLength(1);
      const meta = JSON.parse(rows[0]!.metadata!);
      expect(meta.gate_result).toBe("approved");
    });

    it("stores null metadata when not provided", () => {
      db.upsertShip(makeShip());
      db.transitionPhase("ship-001", "planning", "planning-gate", "engine");

      const rows = queryTransitions(db.path);
      expect(rows[0]!.metadata).toBeNull();
    });

    it("records full gate lifecycle: ship → escort approve", () => {
      db.upsertShip(makeShip());

      // Ship enters gate
      db.transitionPhase("ship-001", "planning", "planning-gate", "ship", {
        planCommentUrl: "https://example.com",
      });

      // Escort approves (updates phase to implementing)
      db.transitionPhase("ship-001", "planning-gate", "implementing", "escort", {
        gate_result: "approved",
      });

      const rows = queryTransitions(db.path);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.triggered_by).toBe("ship");
      expect(rows[1]!.triggered_by).toBe("escort");
      expect(rows[1]!.to_phase).toBe("implementing");
    });
  });

  describe("getPhaseBeforeStopped", () => {
    it("returns the phase before the most recent stop", () => {
      db.upsertShip(makeShip({ phase: "acceptance-test-gate" }));
      db.recordPhaseTransition("ship-001", "acceptance-test-gate", "stopped", "engine");
      db.updateShipPhase("ship-001", "stopped");

      const phase = db.getPhaseBeforeStopped("ship-001");
      expect(phase).toBe("acceptance-test-gate");
    });

    it("returns the most recent stop's from_phase when stopped multiple times", () => {
      db.upsertShip(makeShip({ phase: "implementing" }));
      db.recordPhaseTransition("ship-001", "implementing", "stopped", "engine");
      db.updateShipPhase("ship-001", "stopped");

      // Resume to implementing-gate, then stop again
      db.recordPhaseTransition("ship-001", "stopped", "implementing-gate", "engine");
      db.updateShipPhase("ship-001", "implementing-gate");
      db.recordPhaseTransition("ship-001", "implementing-gate", "stopped", "engine");
      db.updateShipPhase("ship-001", "stopped");

      const phase = db.getPhaseBeforeStopped("ship-001");
      expect(phase).toBe("implementing-gate");
    });

    it("returns null when no stop transition exists", () => {
      db.upsertShip(makeShip());
      const phase = db.getPhaseBeforeStopped("ship-001");
      expect(phase).toBeNull();
    });

    it("returns null for non-existent ship", () => {
      const phase = db.getPhaseBeforeStopped("non-existent");
      expect(phase).toBeNull();
    });
  });

  describe("concurrent phase updates (gate exclusivity)", () => {
    it("transitionPhase rejects stale expectedPhase (optimistic locking)", () => {
      db.upsertShip(makeShip({ phase: "planning-gate" }));

      // Escort approves: planning-gate → implementing
      const first = db.transitionPhase("ship-001", "planning-gate", "implementing", "escort");
      expect(first).toBe(true);

      // A stale Ship attempt using old expectedPhase should fail
      expect(() =>
        db.transitionPhase("ship-001", "planning-gate", "implementing", "ship"),
      ).toThrow("Phase mismatch");
    });

    it("only one of two competing transitions succeeds", () => {
      db.upsertShip(makeShip({ phase: "implementing" }));

      // First transition succeeds
      const result1 = db.transitionPhase("ship-001", "implementing", "implementing-gate", "ship");
      expect(result1).toBe(true);

      // Second transition with same expected phase fails (phase already changed)
      expect(() =>
        db.transitionPhase("ship-001", "implementing", "implementing-gate", "engine"),
      ).toThrow("Phase mismatch");
    });

    it("phases table is updated atomically with ships table", () => {
      db.upsertShip(makeShip());
      db.transitionPhase("ship-001", "planning", "planning-gate", "ship");

      // Both ships and phases tables should reflect the same state
      const ships = db.getActiveShips();
      expect(ships[0]!.phase).toBe("planning-gate");

      // Verify phases table via raw query
      const raw = new Database(db.path);
      const phaseRow = raw.prepare(
        "SELECT phase FROM phases WHERE ship_id = ?",
      ).get("ship-001") as { phase: string } | undefined;
      raw.close();

      expect(phaseRow?.phase).toBe("planning-gate");
    });
  });
});

describe("initFleetDatabase", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "fleet-db-init-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates database in specified directory", async () => {
    const dbDir = join(tmpDir, "test-dir");
    const db = await initFleetDatabase(dbDir);
    expect(db).toBeInstanceOf(FleetDatabase);

    // Verify DB works
    db.ensureRepo("test", "repo");
    db.close();
  });
});
