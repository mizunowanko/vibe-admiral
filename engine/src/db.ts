import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ShipProcess, Phase, EscortProcess } from "./types.js";

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
  actor_snapshot: string | null;
}

/** Persisted escort row stored in SQLite. */
export interface EscortRow {
  id: string;
  ship_id: string;
  session_id: string | null;
  process_pid: number | null;
  phase: string;
  created_at: string;
  completed_at: string | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  cost_usd: number | null;
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
    if (version < 6) {
      this.applyV6();
    }
    if (version < 7) {
      this.applyV7();
    }
    if (version < 8) {
      this.applyV8();
    }
    if (version < 9) {
      this.applyV9();
    }
    if (version < 10) {
      this.applyV10();
    }
    if (version < 11) {
      this.applyV11();
    }
    if (version < 12) {
      this.applyV12();
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
    // V5: Remove stale UNIQUE(repo_id, issue_number) inline constraint.
    // foreign_keys=ON blocks DROP TABLE when other tables reference it.
    // PRAGMA foreign_keys cannot be changed inside a transaction,
    // so we toggle it outside, then use a transaction for the DDL.

    this.db.pragma("foreign_keys = OFF");

    try {
      this.db.exec(`
        DROP TABLE IF EXISTS ships_new;

        BEGIN;

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

        CREATE UNIQUE INDEX idx_ships_repo_issue_kind
          ON ships (repo_id, issue_number, kind);

        INSERT INTO schema_version (version) VALUES (5);

        COMMIT;
      `);
    } catch (e) {
      try { this.db.exec("ROLLBACK;"); } catch { /* already rolled back */ }
      throw e;
    } finally {
      this.db.pragma("foreign_keys = ON");
    }
  }

  private applyV6(): void {
    // V6: Separate escorts from ships table into dedicated escorts table.
    // 1. Create escorts table
    // 2. Migrate existing escort rows from ships to escorts
    // 3. Remove escort rows from ships
    // 4. Rebuild ships table without kind/parent_ship_id columns
    // 5. Restore UNIQUE(repo_id, issue_number) constraint

    this.db.pragma("foreign_keys = OFF");

    try {
      this.db.exec(`
        DROP TABLE IF EXISTS ships_new;
        DROP TABLE IF EXISTS escorts;

        BEGIN;

        -- Create escorts table
        CREATE TABLE escorts (
          id TEXT PRIMARY KEY,
          ship_id TEXT NOT NULL,
          session_id TEXT,
          process_pid INTEGER,
          phase TEXT NOT NULL DEFAULT 'planning',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT
        );

        -- Migrate existing escort data from ships
        INSERT INTO escorts (id, ship_id, session_id, process_pid, phase, created_at, completed_at)
        SELECT id, parent_ship_id, session_id, process_pid, phase, created_at, completed_at
        FROM ships WHERE kind = 'escort' AND parent_ship_id IS NOT NULL;

        -- Delete escort phase_transitions and phases before removing escort ships
        DELETE FROM phase_transitions WHERE ship_id IN (
          SELECT id FROM ships WHERE kind = 'escort'
        );
        DELETE FROM phases WHERE ship_id IN (
          SELECT id FROM ships WHERE kind = 'escort'
        );

        -- Delete escort rows from ships
        DELETE FROM ships WHERE kind = 'escort';

        -- Rebuild ships table without kind/parent_ship_id
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
          completed_at TEXT
        );

        INSERT INTO ships_new (id, repo_id, issue_number, issue_title, worktree_path, branch_name, session_id, pr_url, pr_number, qa_required, process_pid, fleet_id, phase, created_at, completed_at)
        SELECT id, repo_id, issue_number, issue_title, worktree_path, branch_name, session_id, pr_url, pr_number, qa_required, process_pid, fleet_id, phase, created_at, completed_at
        FROM ships;

        DROP TABLE ships;

        ALTER TABLE ships_new RENAME TO ships;

        -- Restore original unique constraint (no kind column needed)
        CREATE UNIQUE INDEX idx_ships_repo_issue ON ships (repo_id, issue_number);

        -- Drop old kind-based index (already removed with table)
        -- No-op since we dropped and recreated the table

        INSERT INTO schema_version (version) VALUES (6);

        COMMIT;
      `);
    } catch (e) {
      try { this.db.exec("ROLLBACK;"); } catch { /* already rolled back */ }
      throw e;
    } finally {
      this.db.pragma("foreign_keys = ON");
    }
  }

  private applyV7(): void {
    // V7: Add foreign key constraint to escorts.ship_id → ships(id).
    // Rebuild escorts table with proper FK for referential integrity.

    this.db.pragma("foreign_keys = OFF");

    try {
      this.db.exec(`
        DROP TABLE IF EXISTS escorts_new;

        BEGIN;

        CREATE TABLE escorts_new (
          id TEXT PRIMARY KEY,
          ship_id TEXT NOT NULL REFERENCES ships(id),
          session_id TEXT,
          process_pid INTEGER,
          phase TEXT NOT NULL DEFAULT 'planning',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT
        );

        INSERT INTO escorts_new (id, ship_id, session_id, process_pid, phase, created_at, completed_at)
        SELECT e.id, e.ship_id, e.session_id, e.process_pid, e.phase, e.created_at, e.completed_at
        FROM escorts e
        WHERE e.ship_id IN (SELECT id FROM ships);

        DROP TABLE escorts;

        ALTER TABLE escorts_new RENAME TO escorts;

        INSERT INTO schema_version (version) VALUES (7);

        COMMIT;
      `);
    } catch (e) {
      try { this.db.exec("ROLLBACK;"); } catch { /* already rolled back */ }
      throw e;
    } finally {
      this.db.pragma("foreign_keys = ON");
    }
  }

  private applyV8(): void {
    // V8: Rename phase values from verbose names to display-name-based names.
    // planning → plan, implementing → coding, acceptance-test → qa
    // Also renames gate phases accordingly.
    this.db.exec(`
      UPDATE ships SET phase = CASE phase
        WHEN 'planning' THEN 'plan'
        WHEN 'planning-gate' THEN 'plan-gate'
        WHEN 'implementing' THEN 'coding'
        WHEN 'implementing-gate' THEN 'coding-gate'
        WHEN 'acceptance-test' THEN 'qa'
        WHEN 'acceptance-test-gate' THEN 'qa-gate'
        ELSE phase
      END
      WHERE phase IN ('planning', 'planning-gate', 'implementing', 'implementing-gate', 'acceptance-test', 'acceptance-test-gate');

      UPDATE phases SET phase = CASE phase
        WHEN 'planning' THEN 'plan'
        WHEN 'planning-gate' THEN 'plan-gate'
        WHEN 'implementing' THEN 'coding'
        WHEN 'implementing-gate' THEN 'coding-gate'
        WHEN 'acceptance-test' THEN 'qa'
        WHEN 'acceptance-test-gate' THEN 'qa-gate'
        ELSE phase
      END
      WHERE phase IN ('planning', 'planning-gate', 'implementing', 'implementing-gate', 'acceptance-test', 'acceptance-test-gate');

      UPDATE phase_transitions SET from_phase = CASE from_phase
        WHEN 'planning' THEN 'plan'
        WHEN 'planning-gate' THEN 'plan-gate'
        WHEN 'implementing' THEN 'coding'
        WHEN 'implementing-gate' THEN 'coding-gate'
        WHEN 'acceptance-test' THEN 'qa'
        WHEN 'acceptance-test-gate' THEN 'qa-gate'
        ELSE from_phase
      END
      WHERE from_phase IN ('planning', 'planning-gate', 'implementing', 'implementing-gate', 'acceptance-test', 'acceptance-test-gate');

      UPDATE phase_transitions SET to_phase = CASE to_phase
        WHEN 'planning' THEN 'plan'
        WHEN 'planning-gate' THEN 'plan-gate'
        WHEN 'implementing' THEN 'coding'
        WHEN 'implementing-gate' THEN 'coding-gate'
        WHEN 'acceptance-test' THEN 'qa'
        WHEN 'acceptance-test-gate' THEN 'qa-gate'
        ELSE to_phase
      END
      WHERE to_phase IN ('planning', 'planning-gate', 'implementing', 'implementing-gate', 'acceptance-test', 'acceptance-test-gate');

      UPDATE escorts SET phase = CASE phase
        WHEN 'planning' THEN 'plan'
        WHEN 'planning-gate' THEN 'plan-gate'
        WHEN 'implementing' THEN 'coding'
        WHEN 'implementing-gate' THEN 'coding-gate'
        WHEN 'acceptance-test' THEN 'qa'
        WHEN 'acceptance-test-gate' THEN 'qa-gate'
        ELSE phase
      END
      WHERE phase IN ('planning', 'planning-gate', 'implementing', 'implementing-gate', 'acceptance-test', 'acceptance-test-gate');

      INSERT INTO schema_version (version) VALUES (8);
    `);
  }

  private applyV9(): void {
    // V9: Add chat_logs table for persisting Ship/Escort chat logs after worktree deletion.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ship_id TEXT NOT NULL REFERENCES ships(id),
        log_type TEXT NOT NULL DEFAULT 'ship',
        data BLOB NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        byte_size INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_chat_logs_ship_id ON chat_logs (ship_id);

      INSERT INTO schema_version (version) VALUES (9);
    `);
  }

  private applyV10(): void {
    // V10: Migrate "stopped" phase to "paused" (#763).
    // Existing stopped ships are treated as paused (backward compatible).
    this.db.exec(`
      UPDATE ships SET phase = 'paused' WHERE phase = 'stopped';
      UPDATE phases SET phase = 'paused' WHERE phase = 'stopped';

      INSERT INTO schema_version (version) VALUES (10);
    `);
  }

  private applyV11(): void {
    // V11: Add actor_snapshot column for XState snapshot persistence (ADR-0017).
    // Stores serialized XState Actor snapshot for O(1) restoration on Engine restart.
    this.db.exec(`
      ALTER TABLE ships ADD COLUMN actor_snapshot TEXT;

      INSERT INTO schema_version (version) VALUES (11);
    `);
  }

  private applyV12(): void {
    // V12: Add token usage tracking columns to escorts table (#800).
    // Tracks cumulative input/output tokens and cost per Escort across gate sessions.
    this.db.exec(`
      ALTER TABLE escorts ADD COLUMN total_input_tokens INTEGER;
      ALTER TABLE escorts ADD COLUMN total_output_tokens INTEGER;
      ALTER TABLE escorts ADD COLUMN cost_usd REAL;

      INSERT INTO schema_version (version) VALUES (12);
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

    // Delete any existing row with the same repo+issue to avoid UNIQUE constraint conflict.
    // Must also delete child rows (phases, phase_transitions) to satisfy foreign key constraints.
    const existingShip = this.db.prepare(
      "SELECT id FROM ships WHERE repo_id = ? AND issue_number = ?",
    ).get(repoId, ship.issueNumber) as { id: string } | undefined;
    if (existingShip && existingShip.id !== ship.id) {
      this.deleteShip(existingShip.id);
    }

    this.db.prepare(`
      INSERT INTO ships (id, repo_id, issue_number, issue_title, worktree_path, branch_name, session_id, pr_url, pr_number, qa_required, fleet_id, phase, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        completed_at = excluded.completed_at
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

  /** Delete a ship and its associated escorts from the database. */
  deleteShip(shipId: string): void {
    this.db.prepare("DELETE FROM escorts WHERE ship_id = ?").run(shipId);
    this.db.prepare("DELETE FROM phase_transitions WHERE ship_id = ?").run(shipId);
    this.db.prepare("DELETE FROM phases WHERE ship_id = ?").run(shipId);
    this.db.prepare("DELETE FROM ships WHERE id = ?").run(shipId);
  }

  /**
   * Transfer phase_transitions and phases from an old ship to a new ship ID.
   * Used during re-sortie to preserve phase history across ship generations.
   * FK constraints are temporarily disabled since the new ship may not exist yet.
   */
  transferTransitionsForReSortie(oldShipId: string, newShipId: string): void {
    this.db.pragma("foreign_keys = OFF");
    try {
      this.db.transaction(() => {
        this.db.prepare(
          "UPDATE phase_transitions SET ship_id = ? WHERE ship_id = ?",
        ).run(newShipId, oldShipId);
        this.db.prepare(
          "DELETE FROM phases WHERE ship_id = ?",
        ).run(oldShipId);
      })();
    } finally {
      this.db.pragma("foreign_keys = ON");
    }
  }

  /** Get all ships with non-terminal phase (for startup restoration).
   *  Includes "paused" and "abandoned" ships so they can be resumed after Engine restart. */
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
      WHERE r.owner = ? AND r.name = ? AND s.issue_number = ? AND s.phase NOT IN ('done', 'paused', 'abandoned')
    `).get(owner, name, issueNumber) as ShipJoinRow | undefined;

    return row ? this.rowToShipProcess(row) : undefined;
  }

  /** Get a ship by repo and issue number (any phase, including done/paused/abandoned). */
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
      WHERE s.phase NOT IN ('done', 'paused', 'abandoned')
    `).all() as Array<{ issue_number: number; owner: string; name: string }>;

    return rows.map((row) => ({
      repo: `${row.owner}/${row.name}`,
      issueNumber: row.issue_number,
    }));
  }

  /**
   * Persist a phase transition that was already validated by XState.
   * DB is responsible only for:
   * 1. Optimistic lock (verify current DB phase matches expectedPhase)
   * 2. Audit log recording
   * 3. Phase persistence (phases + ships tables)
   *
   * Idempotent: if the same transition was recorded within the last 5 seconds, no-op.
   * Returns true if the transition was applied, false if no-op.
   *
   * IMPORTANT: This method must only be called from XState side-effect callbacks
   * or after XState has validated the transition. Direct calls from API handlers
   * are prohibited — use ShipActorManager.requestTransition() instead.
   */
  persistPhaseTransition(
    shipId: string,
    expectedPhase: Phase,
    newPhase: Phase,
    triggeredBy: string,
    metadata?: Record<string, unknown>,
    actorSnapshot?: unknown,
  ): boolean {
    const txn = this.db.transaction(() => {
      // Optimistic lock: verify current phase matches expected
      const current = this.db.prepare(
        "SELECT phase FROM ships WHERE id = ?",
      ).get(shipId) as { phase: string } | undefined;

      if (!current) {
        throw new Error(`Ship ${shipId} not found in database`);
      }
      if (current.phase !== expectedPhase) {
        throw new Error(`Phase mismatch: expected ${expectedPhase}, got ${current.phase}`);
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

      // Update ships table (phase + snapshot in same transaction for consistency)
      if (actorSnapshot !== undefined) {
        this.db.prepare("UPDATE ships SET phase = ?, actor_snapshot = ? WHERE id = ?").run(
          newPhase,
          JSON.stringify(actorSnapshot),
          shipId,
        );
      } else {
        this.db.prepare("UPDATE ships SET phase = ? WHERE id = ?").run(newPhase, shipId);
      }

      return true;
    });

    return txn();
  }

  /** Get the phase a ship was in before it was paused. */
  getPhaseBeforeStopped(shipId: string): Phase | null {
    const row = this.db.prepare(`
      SELECT from_phase FROM phase_transitions
      WHERE ship_id = ? AND to_phase IN ('paused', 'stopped')
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

  // === Chat Log DB methods ===

  /** Persist a compressed chat log for a ship. */
  saveChatLog(
    shipId: string,
    logType: "ship" | "escort",
    compressedData: Buffer,
    messageCount: number,
    rawByteSize: number,
  ): void {
    this.db.prepare(`
      INSERT INTO chat_logs (ship_id, log_type, data, message_count, byte_size)
      VALUES (?, ?, ?, ?, ?)
    `).run(shipId, logType, compressedData, messageCount, rawByteSize);
  }

  /** Load compressed chat logs for a ship from the database. */
  getChatLogs(shipId: string): Array<{ logType: string; data: Buffer; messageCount: number }> {
    const rows = this.db.prepare(
      "SELECT log_type, data, message_count FROM chat_logs WHERE ship_id = ?",
    ).all(shipId) as Array<{ log_type: string; data: Buffer; message_count: number }>;
    return rows.map((row) => ({
      logType: row.log_type,
      data: row.data,
      messageCount: row.message_count,
    }));
  }

  /** Check if chat logs exist for a ship. */
  hasChatLogs(shipId: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM chat_logs WHERE ship_id = ? LIMIT 1",
    ).get(shipId) as { 1: number } | undefined;
    return !!row;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }

  /** Get the database file path. */
  get path(): string {
    return this.db.name;
  }

  // === Escort DB methods ===

  /** Insert or update an escort record. */
  upsertEscort(escort: EscortProcess): void {
    this.db.prepare(`
      INSERT INTO escorts (id, ship_id, session_id, process_pid, phase, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        process_pid = excluded.process_pid,
        phase = excluded.phase,
        completed_at = excluded.completed_at
    `).run(
      escort.id,
      escort.shipId,
      escort.sessionId,
      escort.processPid,
      escort.phase,
      escort.createdAt,
      escort.completedAt,
    );
  }

  /** Get an escort by ID. */
  getEscortById(id: string): EscortProcess | undefined {
    const row = this.db.prepare(
      "SELECT * FROM escorts WHERE id = ?",
    ).get(id) as EscortRow | undefined;
    return row ? this.rowToEscortProcess(row) : undefined;
  }

  /** Get the active escort for a parent Ship (phase != 'done'). */
  getEscortByShipId(shipId: string): EscortProcess | undefined {
    const row = this.db.prepare(
      "SELECT * FROM escorts WHERE ship_id = ? AND phase != 'done' ORDER BY created_at DESC LIMIT 1",
    ).get(shipId) as EscortRow | undefined;
    return row ? this.rowToEscortProcess(row) : undefined;
  }

  /** Update escort phase and optionally completed_at. */
  updateEscortPhase(id: string, phase: string, completedAt?: string): void {
    this.db.prepare(
      "UPDATE escorts SET phase = ?, completed_at = ? WHERE id = ?",
    ).run(phase, completedAt ?? null, id);
  }

  /** Update escort session ID. */
  updateEscortSessionId(id: string, sessionId: string | null): void {
    this.db.prepare(
      "UPDATE escorts SET session_id = ? WHERE id = ?",
    ).run(sessionId, id);
  }

  /** Delete an escort from the database. */
  deleteEscort(id: string): void {
    this.db.prepare("DELETE FROM escorts WHERE id = ?").run(id);
  }

  /** Accumulate token usage for an Escort (adds to existing totals). */
  updateEscortUsage(id: string, inputTokens: number, outputTokens: number, costUsd: number): void {
    this.db.prepare(`
      UPDATE escorts SET
        total_input_tokens = COALESCE(total_input_tokens, 0) + ?,
        total_output_tokens = COALESCE(total_output_tokens, 0) + ?,
        cost_usd = COALESCE(cost_usd, 0) + ?
      WHERE id = ?
    `).run(inputTokens, outputTokens, costUsd, id);
  }

  /** Get Escort usage for a parent Ship (returns the active or most recent Escort). */
  getEscortUsageByShipId(shipId: string): {
    totalInputTokens: number;
    totalOutputTokens: number;
    costUsd: number;
  } | null {
    const row = this.db.prepare(
      "SELECT total_input_tokens, total_output_tokens, cost_usd FROM escorts WHERE ship_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(shipId) as { total_input_tokens: number | null; total_output_tokens: number | null; cost_usd: number | null } | undefined;
    if (!row) return null;
    return {
      totalInputTokens: row.total_input_tokens ?? 0,
      totalOutputTokens: row.total_output_tokens ?? 0,
      costUsd: row.cost_usd ?? 0,
    };
  }

  private rowToEscortProcess(row: EscortRow): EscortProcess {
    return {
      id: row.id,
      shipId: row.ship_id,
      sessionId: row.session_id,
      processPid: row.process_pid,
      phase: row.phase,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      totalInputTokens: row.total_input_tokens,
      totalOutputTokens: row.total_output_tokens,
      costUsd: row.cost_usd,
    };
  }

  /** Get the persisted XState actor snapshot for a ship (ADR-0017). */
  getActorSnapshot(shipId: string): unknown | null {
    const row = this.db.prepare(
      "SELECT actor_snapshot FROM ships WHERE id = ?",
    ).get(shipId) as { actor_snapshot: string | null } | undefined;
    if (!row?.actor_snapshot) return null;
    try {
      return JSON.parse(row.actor_snapshot);
    } catch {
      return null;
    }
  }

  /** Update the actor snapshot for a ship (standalone, outside phase transitions). */
  updateActorSnapshot(shipId: string, snapshot: unknown): void {
    this.db.prepare(
      "UPDATE ships SET actor_snapshot = ? WHERE id = ?",
    ).run(JSON.stringify(snapshot), shipId);
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
