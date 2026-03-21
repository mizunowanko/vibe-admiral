import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ShipProcess, ShipStatus } from "./types.js";

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
  status: string;
  created_at: string;
  completed_at: string | null;
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
  }

  private applyV1(): void {
    this.db.exec(`
      CREATE TABLE repos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(owner, name)
      );

      CREATE TABLE ships (
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

      CREATE TABLE phases (
        ship_id TEXT PRIMARY KEY REFERENCES ships(id),
        phase TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE phase_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ship_id TEXT NOT NULL REFERENCES ships(id),
        from_phase TEXT,
        to_phase TEXT NOT NULL,
        triggered_by TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ship_id TEXT NOT NULL REFERENCES ships(id),
        type TEXT NOT NULL,
        sender TEXT NOT NULL,
        payload TEXT NOT NULL,
        read_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO schema_version (version) VALUES (1);
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

    this.db.prepare(`
      INSERT INTO ships (id, repo_id, issue_number, issue_title, worktree_path, branch_name, session_id, pr_url, pr_number, qa_required, fleet_id, status, created_at, completed_at)
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
        status = excluded.status,
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
      null, // pr_number not tracked on ShipProcess directly (extracted from prUrl)
      ship.qaRequired ? 1 : 0,
      ship.fleetId,
      ship.status,
      ship.createdAt,
      ship.completedAt ? new Date(ship.completedAt).toISOString() : null,
    );
  }

  /** Update ship status and optionally completed_at. */
  updateShipStatus(shipId: string, status: ShipStatus, completedAt?: number): void {
    this.db.prepare(`
      UPDATE ships SET status = ?, completed_at = ? WHERE id = ?
    `).run(
      status,
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
    // Delete related records first (foreign key constraints)
    this.db.prepare("DELETE FROM messages WHERE ship_id = ?").run(shipId);
    this.db.prepare("DELETE FROM phase_transitions WHERE ship_id = ?").run(shipId);
    this.db.prepare("DELETE FROM phases WHERE ship_id = ?").run(shipId);
    this.db.prepare("DELETE FROM ships WHERE id = ?").run(shipId);
  }

  /** Get all ships with non-terminal status (for startup restoration). */
  getActiveShips(): ShipProcess[] {
    const rows = this.db.prepare(`
      SELECT s.*, r.owner, r.name
      FROM ships s
      JOIN repos r ON s.repo_id = r.id
      WHERE s.status NOT IN ('done', 'error')
    `).all() as ShipJoinRow[];

    return rows.map((row) => this.rowToShipProcess(row));
  }

  /** Record a phase transition in the audit log. */
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

    // Upsert current phase
    this.db.prepare(`
      INSERT INTO phases (ship_id, phase, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(ship_id) DO UPDATE SET
        phase = excluded.phase,
        updated_at = excluded.updated_at
    `).run(shipId, toPhase);
  }

  /** Delete all records for ships in terminal states. */
  purgeTerminalShips(): number {
    const terminalShips = this.db.prepare(
      "SELECT id FROM ships WHERE status IN ('done', 'error')",
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
      status: row.status as ShipStatus,
      isCompacting: false,
      prUrl: row.pr_url,
      prReviewStatus: null,
      acceptanceTest: null,
      acceptanceTestApproved: false,
      gateCheck: null,
      qaRequired: row.qa_required === 1,
      escortAgentId: null,
      errorType: null,
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
