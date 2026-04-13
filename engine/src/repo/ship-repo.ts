import type Database from "better-sqlite3";
import type { ShipProcess, Phase } from "../types.js";

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

interface ShipJoinRow extends ShipRow {
  owner: string;
  name: string;
}

export class ShipRepo {
  constructor(private db: Database.Database) {}

  /**
   * Ensure a repo row exists for the given (owner, name, fleetId) tuple.
   * After V16, repos have UNIQUE(owner, name, fleet_id).
   *
   * Throws if the repo exists under a DIFFERENT fleet — use transferRepoFleet()
   * to explicitly move ownership (ADR-0024 Decision 2).
   */
  ensureRepo(owner: string, name: string, fleetId?: string): number {
    const existing = this.db.prepare(
      "SELECT id, fleet_id FROM repos WHERE owner = ? AND name = ?",
    ).get(owner, name) as { id: number; fleet_id: string | null } | undefined;
    if (existing) {
      const isAssigned = existing.fleet_id && existing.fleet_id !== "__unassigned__";
      if (fleetId && isAssigned && existing.fleet_id !== fleetId) {
        throw new Error(
          `[db] Repo ${owner}/${name} belongs to fleet ${existing.fleet_id!.slice(0, 8)}..., ` +
          `cannot assign to fleet ${fleetId.slice(0, 8)}... — use transferRepoFleet() for explicit transfer`,
        );
      }
      if (fleetId && (!isAssigned || existing.fleet_id !== fleetId)) {
        this.db.prepare("UPDATE repos SET fleet_id = ? WHERE id = ?").run(fleetId, existing.id);
      }
      return existing.id;
    }

    const result = this.db.prepare(
      "INSERT INTO repos (owner, name, fleet_id) VALUES (?, ?, ?)",
    ).run(owner, name, fleetId ?? "__unassigned__");
    return Number(result.lastInsertRowid);
  }

  /**
   * Explicitly transfer a repo to a different fleet (ADR-0024).
   * Audit-logged — only callable via Dock commands.
   */
  transferRepoFleet(owner: string, name: string, newFleetId: string): void {
    const existing = this.db.prepare(
      "SELECT id, fleet_id FROM repos WHERE owner = ? AND name = ?",
    ).get(owner, name) as { id: number; fleet_id: string | null } | undefined;
    if (!existing) {
      throw new Error(`[db] Repo ${owner}/${name} not found — cannot transfer`);
    }
    const oldFleetId = existing.fleet_id;
    this.db.prepare("UPDATE repos SET fleet_id = ? WHERE id = ?").run(newFleetId, existing.id);
    console.log(
      `[db] Transferred repo ${owner}/${name} from fleet ${oldFleetId?.slice(0, 8) ?? "null"} ` +
      `to fleet ${newFleetId.slice(0, 8)}...`,
    );
  }

  upsertShip(ship: ShipProcess): void {
    const [owner, name] = ship.repo.split("/");
    if (!owner || !name) return;

    const repoId = this.ensureRepo(owner, name, ship.fleetId);

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

  updateShipPhase(shipId: string, phase: Phase, completedAt?: number): void {
    this.db.prepare(`
      UPDATE ships SET phase = ?, completed_at = ? WHERE id = ?
    `).run(
      phase,
      completedAt ? new Date(completedAt).toISOString() : null,
      shipId,
    );
  }

  updateShipSessionId(shipId: string, sessionId: string | null): void {
    this.db.prepare("UPDATE ships SET session_id = ? WHERE id = ?").run(
      sessionId,
      shipId,
    );
  }

  deleteShip(shipId: string): void {
    this.db.pragma("foreign_keys = OFF");
    try {
      this.db.transaction(() => {
        this.db.prepare("DELETE FROM escorts WHERE ship_id = ?").run(shipId);
        this.db.prepare("DELETE FROM phase_transitions WHERE ship_id = ?").run(shipId);
        this.db.prepare("DELETE FROM phases WHERE ship_id = ?").run(shipId);
        this.db.prepare("DELETE FROM ships WHERE id = ?").run(shipId);
      })();
    } finally {
      this.db.pragma("foreign_keys = ON");
    }
  }

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

  getActiveShips(): ShipProcess[] {
    const rows = this.db.prepare(`
      SELECT s.*, r.owner, r.name
      FROM ships s
      JOIN repos r ON s.repo_id = r.id
      WHERE s.phase != 'done'
    `).all() as ShipJoinRow[];

    return rows.map((row) => this.rowToShipProcess(row));
  }

  getAllShips(): ShipProcess[] {
    const rows = this.db.prepare(`
      SELECT s.*, r.owner, r.name
      FROM ships s
      JOIN repos r ON s.repo_id = r.id
      ORDER BY s.created_at ASC
    `).all() as ShipJoinRow[];

    return rows.map((row) => this.rowToShipProcess(row));
  }

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

  getShipById(shipId: string): ShipProcess | undefined {
    const row = this.db.prepare(`
      SELECT s.*, r.owner, r.name
      FROM ships s
      JOIN repos r ON s.repo_id = r.id
      WHERE s.id = ?
    `).get(shipId) as ShipJoinRow | undefined;

    return row ? this.rowToShipProcess(row) : undefined;
  }

  getShipByIssue(repo: string, issueNumber: number, fleetId?: string): ShipProcess | undefined {
    const [owner, name] = repo.split("/");
    if (!owner || !name) return undefined;

    const sql = fleetId
      ? `SELECT s.*, r.owner, r.name FROM ships s JOIN repos r ON s.repo_id = r.id
         WHERE r.owner = ? AND r.name = ? AND s.issue_number = ? AND s.fleet_id = ? AND s.phase NOT IN ('done', 'paused', 'abandoned')`
      : `SELECT s.*, r.owner, r.name FROM ships s JOIN repos r ON s.repo_id = r.id
         WHERE r.owner = ? AND r.name = ? AND s.issue_number = ? AND s.phase NOT IN ('done', 'paused', 'abandoned')`;
    const params = fleetId ? [owner, name, issueNumber, fleetId] : [owner, name, issueNumber];
    const row = this.db.prepare(sql).get(...params) as ShipJoinRow | undefined;

    return row ? this.rowToShipProcess(row) : undefined;
  }

  getShipByIssueAnyPhase(repo: string, issueNumber: number, fleetId?: string): ShipProcess | undefined {
    const [owner, name] = repo.split("/");
    if (!owner || !name) return undefined;

    const sql = fleetId
      ? `SELECT s.*, r.owner, r.name FROM ships s JOIN repos r ON s.repo_id = r.id
         WHERE r.owner = ? AND r.name = ? AND s.issue_number = ? AND s.fleet_id = ?`
      : `SELECT s.*, r.owner, r.name FROM ships s JOIN repos r ON s.repo_id = r.id
         WHERE r.owner = ? AND r.name = ? AND s.issue_number = ?`;
    const params = fleetId ? [owner, name, issueNumber, fleetId] : [owner, name, issueNumber];
    const row = this.db.prepare(sql).get(...params) as ShipJoinRow | undefined;

    return row ? this.rowToShipProcess(row) : undefined;
  }

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
