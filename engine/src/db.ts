import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ShipProcess, Phase, ShipKind } from "./types.js";
import { PHASE_ORDER } from "./types.js";

/** Persisted ship row stored in SQLite. */
export interface ShipRow {
  id: string;
  repo_id: number;
  issue_number: number;
  issue_title: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  session_id: string | null;
  pr_url: string | null;
  pr_number: number | null;
  qa_required: number | null;
  process_pid: number | null;
  fleet_id: string | null;
  phase: string;
  created_at: string;
  completed_at: string | null;
  kind: string | null;
  parent_ship_id: string | null;
}

/** Row returned by the ships+repos join query. */
interface ShipJoinRow extends ShipRow {
  owner: string;
  name: string;
}

export class FleetDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    // Create migrations tracking table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    const currentVersion = this.db.prepare(
      "SELECT MAX(version) as v FROM schema_version",
    ).get() as { v: number | null } | undefined;
    const version = currentVersion?.v ?? 0;

    if (version < 1) {
      this.applyV1();
    }
    if (version < 2) {
      this.applyV2();
    }
    if (version < 3) {
      this.applyV3();
    }
    if (version < 4) {
      this.applyV4();
    }
    if (version < 5) {
      this.applyV5();
    }
  }

  private applyV1(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(owner, name)
      );

      CREATE TABLE IF NOT EXISTS ships (
        id TEXT PRIMARY KEY,
        repo_id INTEGER NOT NULL REFERENCES repos(id),
        issue_number INTEGER NOT NULL,
        issue_title TEXT,
        worktree_path TEXT,
        branch_name TEXT,
        session_id TEXT,
        pr_url TEXT,
        pr_number INTEGER,
        qa_required BOOLEAN,
        process_pid INTEGER,
        fleet_id TEXT,
        status TEXT NOT NULL DEFAULT 'planning',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        UNIQUE(repo_id, issue_number)
      );

      CREATE TABLE IF NOT EXISTS phases (
        ship_id TEXT PRIMARY KEY REFERENCES ships(id),
        phase TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS phase_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ship_id TEXT NOT NULL REFERENCES ships(id),
        from_phase TEXT,
        to_phase TEXT NOT NULL,
        triggered_by TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ship_id TEXT NOT NULL REFERENCES ships(id),
        type TEXT NOT NULL,
        sender TEXT NOT NULL,
        payload TEXT NOT NULL,
        read_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT OR IGNORE INTO schema_version (version) VALUES (1);
    `);
  }

  private applyV2(): void {
    // V2: Rename ships.status → ships.phase, add index on messages for ship polling.
    // Also migrate 'error' status to 'planning' (error is now a derived state).
    this.db.exec(`
      ALTER TABLE ships RENAME COLUMN status TO phase;

      UPDATE ships SET phase = 'planning' WHERE phase = 'error';

      CREATE INDEX IF NOT EXISTS idx_messages_ship_unread
        ON messages (ship_id, type, read_at);

      INSERT INTO schema_version (version) VALUES (2);
    `);
  }

  private applyV3(): void {
    // V3: Drop messages table (replaced by direct DB phase updates + Escort model).
    this.db.exec(`
      DROP INDEX IF EXISTS idx_messages_ship_unread;
      DROP TABLE IF EXISTS messages;

      INSERT INTO schema_version (version) VALUES (3);
    `);
  }

  private applyV4(): void {
    // V4: Add kind + parent_ship_id columns for persistent Escort-as-Ship model.
    // Relax UNIQUE(repo_id, issue_number) to UNIQUE(repo_id, issue_number, kind)
    // so both a Ship and its Escort can coexist for the same issue.
    this.db.exec(`
      ALTER TABLE ships ADD COLUMN kind TEXT NOT NULL DEFAULT 'ship';
      ALTER TABLE ships ADD COLUMN parent_ship_id TEXT;

      -- Recreate unique index to include kind
      DROP INDEX IF EXISTS idx_ships_repo_issue;
      CREATE UNIQUE INDEX idx_ships_repo_issue_kind ON ships (repo_id, issue_number, kind);

      INSERT INTO schema_version (version) VALUES (4);
    `);
  }

  private applyV5(): void {
    // V5: Remove stale UNIQUE(repo_id, issue_number) inline constraint from V1 schema.
    // V4 tried DROP INDEX but the constraint was inline (auto-generated as
    // sqlite_autoindex_ships_2), so it was never removed. This blocks Escort
    // insertion for the same issue. SQLite requires table rebuild to drop
    // inline constraints.
    this.db.exec(`
      CREATE TABLE ships_new (
        id TEXT PRIMARY KEY,
        repo_id INTEGER NOT NULL REFERENCES repos(id),
        issue_number INTEGER NOT NULL,
        issue_title TEXT,
        worktree_path TEXT,
        branch_name TEXT,
        session_id TEXT,
        pr_url TEXT,
        pr_number INTEGER,
        qa_required BOOLEAN,
        process_pid INTEGER,
        fleet_id TEXT,
        phase TEXT NOT NULL DEFAULT 'planning',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        kind TEXT NOT NULL DEFAULT 'ship',
        parent_ship_id TEXT
      );

      INSERT INTO ships_new SELECT * FROM ships;

      DROP TABLE ships;

      ALTER TABLE ships_new RENAME TO ships;

      CREATE UNIQUE INDEX idx_ships_repo_issue_kind ON ships (repo_id, issue_number, kind);

      INSERT INTO schema_version (version) VALUES (5);
    `);
  }

  /** Ensure a repo row exists and return its ID. */
  ensureRepo(owner: string, name: string): number {
    const existing = this.db.prepare(
      "SELECT id FROM repos WHERE owner = ? AND name = ?",
    ).get(owner, name) as { id: number } | undefined;
    if (existing) return existing.id;

    const result = this.db.prepare(
      "INSERT INTO repos (owner, name) VALUES (?, ?)",
    ).run(owner, name);
    return Number(result.lastInsertRowid);
  }

  /** Insert or update a ship record. */
  upsertShip(ship: ShipProcess): void {
    const [owner, name] = ship.repo.split("/");
    if (!owner || !name) return;

    const repoId = this.ensureRepo(owner, name);

    // Delete any existing row with the same repo+issue+kind to avoid UNIQUE constraint conflict.
    // Must also delete child rows (phases, phase_transitions) to satisfy foreign key constraints.
    const kind = ship.kind ?? "ship";
    const existingShip = this.db.prepare(
      "SELECT id FROM ships WHERE repo_id = ? AND issue_number = ? AND kind = ?",
    ).get(repoId, ship.issueNumber, kind) as { id: string } | undefined;
    if (existingShip) {
      this.deleteShip(existingShip.id);
    }

    this.db.prepare(`
      INSERT INTO ships (id, repo_id, issue_number, issue_title, worktree_path, branch_name, session_id, pr_url, pr_number, qa_required, fleet_id, phase, created_at, completed_at, kind, parent_ship_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        issue_title = excluded.issue_title,
        worktree_path = excluded.worktree_path,
        branch_name = excluded.branch_name,
        session_id = excluded.session_id,
        pr_url = excluded.pr_url,
        pr_number = excluded.pr_number,
        qa_required = excluded.qa_required,
        fleet_id = excluded.fleet_id,
        phase = excluded.phase,
        completed_at = excluded.completed_at,
        kind = excluded.kind,
        parent_ship_id = excluded.parent_ship_id
    `).run(
      ship.id,
      repoId,
      ship.issueNumber,
      ship.issueTitle,
      ship.worktreePath,
      ship.branchName,
      ship.sessionId,
      ship.prUrl,
      null,
      ship.qaRequired ? 1 : 0,
      ship.fleetId,
      ship.phase,
      ship.createdAt,
      ship.completedAt ? new Date(ship.completedAt).toISOString() : null,
      kind,
      ship.parentShipId,
    );
  }

  /** Update ship phase and optionally completed_at. */
  updateShipPhase(shipId: string, phase: Phase, completedAt?: number): void {
    this.db.prepare(`
      UPDATE ships SET phase = ?, completed_at = ? WHERE id = ?
    `).run(
      phase,
      completedAt ? new Date(completedAt).toISOString() : null,
      shipId,
    );
  }

  /** Update ship session ID. */
  updateShipSessionId(shipId: string, sessionId: string | null): void {
    this.db.prepare("UPDATE ships SET session_id = ? WHERE id = ?").run(
      sessionId,
      shipId,
    );
  }

  /** Delete a ship from the database. */
  deleteShip(shipId: string): void {
    this.db.prepare("DELETE FROM phase_transitions WHERE ship_id = ?").run(shipId);
    this.db.prepare("DELETE FROM phases WHERE ship_id = ?").run(shipId);
    this.db.prepare("DELETE FROM ships WHERE id = ?").run(shipId);
  }

  /** Get all ships with non-terminal phase (for startup restoration).
   *  Includes "stopped" ships so they can be resumed after Engine restart. */
  getActiveShips(): ShipProcess[] {
    const rows = this.db.prepare(`
      SELECT s.*, r.owner, r.name
      FROM ships s
      JOIN repos r ON s.repo_id = r.id
      WHERE s.phase != 'done'
    `).all() as ShipJoinRow[];

    return rows.map((row) => this.rowToShipProcess(row));
  }

  /** Get all ships (including done) from the database. */
  getAllShips(): ShipProcess[] {
    const rows = this.db.prepare(`
      SELECT s.*, r.owner, r.name
      FROM ships s
      JOIN repos r ON s.repo_id = r.id
      ORDER BY s.created_at ASC
    `).all() as ShipJoinRow[];

    return rows.map((row) => this.rowToShipProcess(row));
  }

  /** Get all ships for a specific fleet. */
  getShipsByFleet(fleetId: string): ShipProcess[] {
    const rows = this.db.prepare(`
      SELECT s.*, r.owner, r.name
      FROM ships s
      JOIN repos r ON s.repo_id = r.id
      WHERE s.fleet_id = ?
      ORDER BY s.created_at ASC
    `).all(fleetId) as ShipJoinRow[];

    return rows.map((row) => this.rowToShipProcess(row));
  }

  /** Get a single ship by ID. */
  getShipById(shipId: string): ShipProcess | undefined {
    const row = this.db.prepare(`
      SELECT s.*, r.owner, r.name
      FROM ships s
      JOIN repos r ON s.repo_id = r.id
      WHERE s.id = ?
    `).get(shipId) as ShipJoinRow | undefined;

    return row ? this.rowToShipProcess(row) : undefined;
  }

  /** Get a ship by repo and issue number (active only, phase != done). */
  getShipByIssue(repo: string, issueNumber: number): ShipProcess | undefined {
    const [owner, name] = repo.split("/");
    if (!owner || !name) return undefined;

    const row = this.db.prepare(`
      SELECT s.*, r.owner, r.name
      FROM ships s
      JOIN repos r ON s.repo_id = r.id
      WHERE r.owner = ? AND r.name = ? AND s.issue_number = ? AND s.phase NOT IN ('done', 'stopped')
    `).get(owner, name, issueNumber) as ShipJoinRow | undefined;

    return row ? this.rowToShipProcess(row) : undefined;
  }

  /** Get a ship by repo and issue number (any phase, including done/stopped). */
  getShipByIssueAnyPhase(repo: string, issueNumber: number): ShipProcess | undefined {
    const [owner, name] = repo.split("/");
    if (!owner || !name) return undefined;

    const row = this.db.prepare(`
      SELECT s.*, r.owner, r.name
      FROM ships s
      JOIN repos r ON s.repo_id = r.id
      WHERE r.owner = ? AND r.name = ? AND s.issue_number = ?
    `).get(owner, name, issueNumber) as ShipJoinRow | undefined;

    return row ? this.rowToShipProcess(row) : undefined;
  }

  /** Get active ship issue numbers (phase != done). */
  getActiveShipIssueNumbers(): Array<{ repo: string; issueNumber: number }> {
    const rows = this.db.prepare(`
      SELECT s.issue_number, r.owner, r.name
      FROM ships s
      JOIN repos r ON s.repo_id = r.id
      WHERE s.phase NOT IN ('done', 'stopped')
    `).all() as Array<{ issue_number: number; owner: string; name: string }>;

    return rows.map((row) => ({
      repo: `${row.owner}/${row.name}`,
      issueNumber: row.issue_number,
    }));
  }

  /**
   * Transactional phase transition.
   * 1. Verify current phase matches expected
   * 2. Insert phase_transition audit log
   * 3. Update phases table
   * 4. Update ships.phase
   *
   * Idempotent: if the same transition was recorded within the last 5 seconds, no-op.
   * Returns true if the transition was applied, false if no-op.
   */
  transitionPhase(
    shipId: string,
    expectedPhase: Phase,
    newPhase: Phase,
    triggeredBy: string,
    metadata?: Record<string, unknown>,
  ): boolean {
    const txn = this.db.transaction(() => {
      // Check current phase
      const current = this.db.prepare(
        "SELECT phase FROM ships WHERE id = ?",
      ).get(shipId) as { phase: string } | undefined;

      if (!current) {
        throw new Error(`Ship ${shipId} not found in database`);
      }
      if (current.phase !== expectedPhase) {
        throw new Error(`Phase mismatch: expected ${expectedPhase}, got ${current.phase}`);
      }

      // Validate forward-only (with gate-reject exception)
      const currentIdx = PHASE_ORDER.indexOf(expectedPhase as Phase);
      const newIdx = PHASE_ORDER.indexOf(newPhase);
      if (newIdx <= currentIdx) {
        // Allow gate rejection: gate-phase → preceding work phase
        const isGateReject =
          (expectedPhase === "planning-gate" && newPhase === "planning") ||
          (expectedPhase === "implementing-gate" && newPhase === "implementing") ||
          (expectedPhase === "acceptance-test-gate" && newPhase === "acceptance-test");
        if (!isGateReject) {
          throw new Error(`Cannot go backward: ${expectedPhase} → ${newPhase}`);
        }
      }

      // Idempotency: check if same transition was recorded in last 5 seconds
      const recent = this.db.prepare(`
        SELECT id FROM phase_transitions
        WHERE ship_id = ? AND from_phase = ? AND to_phase = ?
          AND created_at > datetime('now', '-5 seconds')
        LIMIT 1
      `).get(shipId, expectedPhase, newPhase) as { id: number } | undefined;

      if (recent) {
        return false;
      }

      // Insert audit log
      this.db.prepare(`
        INSERT INTO phase_transitions (ship_id, from_phase, to_phase, triggered_by, metadata)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        shipId,
        expectedPhase,
        newPhase,
        triggeredBy,
        metadata ? JSON.stringify(metadata) : null,
      );

      // Upsert current phase
      this.db.prepare(`
        INSERT INTO phases (ship_id, phase, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(ship_id) DO UPDATE SET
          phase = excluded.phase,
          updated_at = excluded.updated_at
      `).run(shipId, newPhase);

      // Update ships table
      this.db.prepare("UPDATE ships SET phase = ? WHERE id = ?").run(newPhase, shipId);

      return true;
    });

    return txn();
  }

  /** Get the phase a ship was in before it was stopped. */
  getPhaseBeforeStopped(shipId: string): Phase | null {
    const row = this.db.prepare(`
      SELECT from_phase FROM phase_transitions
      WHERE ship_id = ? AND to_phase = 'stopped'
      ORDER BY id DESC LIMIT 1
    `).get(shipId) as { from_phase: string | null } | undefined;
    return (row?.from_phase as Phase) ?? null;
  }

  /** Record a phase transition in the audit log (non-transactional, for backward compat). */
  recordPhaseTransition(
    shipId: string,
    fromPhase: string | null,
    toPhase: string,
    triggeredBy: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.db.prepare(`
      INSERT INTO phase_transitions (ship_id, from_phase, to_phase, triggered_by, metadata)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      shipId,
      fromPhase,
      toPhase,
      triggeredBy,
      metadata ? JSON.stringify(metadata) : null,
    );

    this.db.prepare(`
      INSERT INTO phases (ship_id, phase, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(ship_id) DO UPDATE SET
        phase = excluded.phase,
        updated_at = excluded.updated_at
    `).run(shipId, toPhase);
  }

  /** Get recent phase transitions for a ship, ordered by most recent first. */
  getPhaseTransitions(shipId: string, limit: number = 10): Array<Record<string, unknown>> {
    const rows = this.db.prepare(`
      SELECT id, ship_id, from_phase, to_phase, triggered_by, metadata, created_at
      FROM phase_transitions
      WHERE ship_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(shipId, limit) as Array<{
      id: number;
      ship_id: string;
      from_phase: string | null;
      to_phase: string;
      triggered_by: string;
      metadata: string | null;
      created_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      shipId: row.ship_id,
      fromPhase: row.from_phase,
      toPhase: row.to_phase,
      triggeredBy: row.triggered_by,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      createdAt: row.created_at,
    }));
  }

  /** Delete all records for ships in terminal states. */
  purgeTerminalShips(): number {
    const terminalShips = this.db.prepare(
      "SELECT id FROM ships WHERE phase = 'done'",
    ).all() as Array<{ id: string }>;

    for (const ship of terminalShips) {
      this.deleteShip(ship.id);
    }

    return terminalShips.length;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }

  /** Get the database file path. */
  get path(): string {
    return this.db.name;
  }

  private rowToShipProcess(row: ShipJoinRow): ShipProcess {
    return {
      id: row.id,
      fleetId: row.fleet_id ?? "",
      repo: `${row.owner}/${row.name}`,
      issueNumber: row.issue_number,
      issueTitle: row.issue_title ?? "",
      worktreePath: row.worktree_path ?? "",
      branchName: row.branch_name ?? "",
      sessionId: row.session_id,
      phase: row.phase as Phase,
      isCompacting: false,
      prUrl: row.pr_url,
      prReviewStatus: null,
      gateCheck: null,
      qaRequired: row.qa_required === 1,
      retryCount: 0,
      createdAt: row.created_at,
      completedAt: row.completed_at ? new Date(row.completed_at).getTime() : undefined,
      lastOutputAt: null,
      kind: (row.kind as ShipKind) ?? "ship",
      parentShipId: row.parent_ship_id,
    };
  }
}

/** Initialize the fleet database, creating the directory if needed.
 *  @param dbDir - Directory where fleet.db will be stored (created if needed).
 */
export async function initFleetDatabase(dbDir: string): Promise<FleetDatabase> {
  await mkdir(dbDir, { recursive: true });
  const dbPath = join(dbDir, "fleet.db");
  return new FleetDatabase(dbPath);
}
