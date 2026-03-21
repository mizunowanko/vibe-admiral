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
    status: "planning",
    isCompacting: false,
    branchName: "feature/42-test",
    worktreePath: "/repo/.worktrees/feature/42-test",
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

      const updated = makeShip({ status: "implementing", issueTitle: "Updated" });
      db.upsertShip(updated);

      const ships = db.getActiveShips();
      expect(ships).toHaveLength(1);
      expect(ships[0]!.status).toBe("implementing");
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
      db.upsertShip(makeShip({ id: "s1", status: "planning" }));
      db.upsertShip(makeShip({ id: "s2", issueNumber: 43, status: "done", completedAt: Date.now() }));
      db.upsertShip(makeShip({ id: "s3", issueNumber: 44, status: "implementing" }));
      db.upsertShip(makeShip({ id: "s4", issueNumber: 45, status: "error", completedAt: Date.now() }));

      const active = db.getActiveShips();
      expect(active).toHaveLength(2);
      const ids = active.map((s) => s.id).sort();
      expect(ids).toEqual(["s1", "s3"]);
    });

    it("returns empty array when no active ships", () => {
      db.upsertShip(makeShip({ status: "done", completedAt: Date.now() }));
      expect(db.getActiveShips()).toHaveLength(0);
    });

    it("restores qaRequired correctly", () => {
      db.upsertShip(makeShip({ qaRequired: false }));
      const ships = db.getActiveShips();
      expect(ships[0]!.qaRequired).toBe(false);
    });
  });

  describe("updateShipStatus", () => {
    it("updates status for an existing ship", () => {
      db.upsertShip(makeShip());
      db.updateShipStatus("ship-001", "implementing");

      const ships = db.getActiveShips();
      expect(ships[0]!.status).toBe("implementing");
    });

    it("sets completedAt for terminal statuses", () => {
      db.upsertShip(makeShip());
      const now = Date.now();
      db.updateShipStatus("ship-001", "done", now);

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

  describe("purgeTerminalShips", () => {
    it("removes ships in done and error states", () => {
      db.upsertShip(makeShip({ id: "s1", status: "planning" }));
      db.upsertShip(makeShip({ id: "s2", issueNumber: 43, status: "done", completedAt: Date.now() }));
      db.upsertShip(makeShip({ id: "s3", issueNumber: 44, status: "error", completedAt: Date.now() }));

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
