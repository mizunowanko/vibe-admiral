import type Database from "better-sqlite3";
import type { Phase } from "../types.js";
import { safeJsonParse } from "../util/json-safe.js";

export class PhaseRepo {
  constructor(private db: Database.Database) {}

  persistPhaseTransition(
    shipId: string,
    expectedPhase: Phase,
    newPhase: Phase,
    triggeredBy: string,
    metadata?: Record<string, unknown>,
    actorSnapshot?: unknown,
  ): boolean {
    const txn = this.db.transaction(() => {
      const current = this.db.prepare(
        "SELECT phase FROM ships WHERE id = ?",
      ).get(shipId) as { phase: string } | undefined;

      if (!current) {
        throw new Error(`Ship ${shipId} not found in database`);
      }
      if (current.phase !== expectedPhase) {
        throw new Error(`Phase mismatch: expected ${expectedPhase}, got ${current.phase}`);
      }

      const recent = this.db.prepare(`
        SELECT id FROM phase_transitions
        WHERE ship_id = ? AND from_phase = ? AND to_phase = ?
          AND created_at > datetime('now', '-5 seconds')
        LIMIT 1
      `).get(shipId, expectedPhase, newPhase) as { id: number } | undefined;

      if (recent) {
        return false;
      }

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

      this.db.prepare(`
        INSERT INTO phases (ship_id, phase, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(ship_id) DO UPDATE SET
          phase = excluded.phase,
          updated_at = excluded.updated_at
      `).run(shipId, newPhase);

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

  getPhaseBeforeStopped(shipId: string): Phase | null {
    const row = this.db.prepare(`
      SELECT from_phase FROM phase_transitions
      WHERE ship_id = ? AND to_phase IN ('paused', 'stopped')
      ORDER BY id DESC LIMIT 1
    `).get(shipId) as { from_phase: string | null } | undefined;
    return (row?.from_phase as Phase) ?? null;
  }

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
      metadata: safeJsonParse(row.metadata, "phase-transition.metadata", null),
      createdAt: row.created_at,
    }));
  }

  purgeTerminalShips(deleteShip: (shipId: string) => void): number {
    const terminalShips = this.db.prepare(
      "SELECT id FROM ships WHERE phase = 'done'",
    ).all() as Array<{ id: string }>;

    for (const ship of terminalShips) {
      deleteShip(ship.id);
    }

    return terminalShips.length;
  }
}
