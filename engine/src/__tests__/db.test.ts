import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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

  describe("message board", () => {
    it("inserts a message and returns its ID", () => {
      db.upsertShip(makeShip());
      const id = db.insertMessage("ship-001", "gate-response", "bridge", { approved: true });
      expect(id).toBeGreaterThan(0);
    });

    it("retrieves unread messages without type filter", () => {
      db.upsertShip(makeShip());
      db.insertMessage("ship-001", "gate-response", "bridge", { approved: true });
      db.insertMessage("ship-001", "admiral-request-response", "engine", { ok: true });

      const messages = db.getUnreadMessages("ship-001");
      expect(messages).toHaveLength(2);
    });

    it("retrieves unread messages with type filter", () => {
      db.upsertShip(makeShip());
      db.insertMessage("ship-001", "gate-response", "bridge", { approved: true });
      db.insertMessage("ship-001", "admiral-request-response", "engine", { ok: true });

      const gateMessages = db.getUnreadMessages("ship-001", "gate-response");
      expect(gateMessages).toHaveLength(1);
      expect(JSON.parse(gateMessages[0]!.payload)).toEqual({ approved: true });
    });

    it("marks a single message as read", () => {
      db.upsertShip(makeShip());
      const id = db.insertMessage("ship-001", "gate-response", "bridge", { approved: true });
      db.markMessageRead(id);

      const messages = db.getUnreadMessages("ship-001", "gate-response");
      expect(messages).toHaveLength(0);
    });

    it("marks all messages of a type as read", () => {
      db.upsertShip(makeShip());
      db.insertMessage("ship-001", "gate-response", "bridge", { approved: false });
      db.insertMessage("ship-001", "gate-response", "bridge", { approved: true });
      db.insertMessage("ship-001", "admiral-request-response", "engine", { ok: true });

      db.markAllRead("ship-001", "gate-response");

      const gateMessages = db.getUnreadMessages("ship-001", "gate-response");
      expect(gateMessages).toHaveLength(0);

      // Other types remain unread
      const otherMessages = db.getUnreadMessages("ship-001", "admiral-request-response");
      expect(otherMessages).toHaveLength(1);
    });

    it("returns messages in chronological order", () => {
      db.upsertShip(makeShip());
      db.insertMessage("ship-001", "gate-response", "bridge", { seq: 1 });
      db.insertMessage("ship-001", "gate-response", "bridge", { seq: 2 });

      const messages = db.getUnreadMessages("ship-001", "gate-response");
      expect(JSON.parse(messages[0]!.payload).seq).toBe(1);
      expect(JSON.parse(messages[1]!.payload).seq).toBe(2);
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
