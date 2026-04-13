import type Database from "better-sqlite3";
import type { EscortProcess } from "../types.js";

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
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cost_usd: number | null;
}

export class EscortRepo {
  constructor(private db: Database.Database) {}

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

  getEscortById(id: string): EscortProcess | undefined {
    const row = this.db.prepare(
      "SELECT * FROM escorts WHERE id = ?",
    ).get(id) as EscortRow | undefined;
    return row ? this.rowToEscortProcess(row) : undefined;
  }

  getEscortByShipId(shipId: string): EscortProcess | undefined {
    const row = this.db.prepare(
      "SELECT * FROM escorts WHERE ship_id = ? AND phase != 'done' ORDER BY created_at DESC LIMIT 1",
    ).get(shipId) as EscortRow | undefined;
    return row ? this.rowToEscortProcess(row) : undefined;
  }

  updateEscortPhase(id: string, phase: string, completedAt?: string): void {
    this.db.prepare(
      "UPDATE escorts SET phase = ?, completed_at = ? WHERE id = ?",
    ).run(phase, completedAt ?? null, id);
  }

  updateEscortSessionId(id: string, sessionId: string | null): void {
    this.db.prepare(
      "UPDATE escorts SET session_id = ? WHERE id = ?",
    ).run(sessionId, id);
  }

  deleteEscort(id: string): void {
    this.db.prepare("DELETE FROM escorts WHERE id = ?").run(id);
  }

  updateEscortUsage(
    id: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadInputTokens: number,
    cacheCreationInputTokens: number,
    costUsd: number,
  ): void {
    this.db.prepare(`
      UPDATE escorts SET
        total_input_tokens = COALESCE(total_input_tokens, 0) + ?,
        total_output_tokens = COALESCE(total_output_tokens, 0) + ?,
        cache_read_input_tokens = COALESCE(cache_read_input_tokens, 0) + ?,
        cache_creation_input_tokens = COALESCE(cache_creation_input_tokens, 0) + ?,
        cost_usd = COALESCE(cost_usd, 0) + ?
      WHERE id = ?
    `).run(inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUsd, id);
  }

  getEscortUsageByShipId(shipId: string): {
    totalInputTokens: number;
    totalOutputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    costUsd: number;
  } | null {
    const row = this.db.prepare(
      "SELECT total_input_tokens, total_output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cost_usd FROM escorts WHERE ship_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(shipId) as { total_input_tokens: number | null; total_output_tokens: number | null; cache_read_input_tokens: number | null; cache_creation_input_tokens: number | null; cost_usd: number | null } | undefined;
    if (!row) return null;
    return {
      totalInputTokens: row.total_input_tokens ?? 0,
      totalOutputTokens: row.total_output_tokens ?? 0,
      cacheReadInputTokens: row.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: row.cache_creation_input_tokens ?? 0,
      costUsd: row.cost_usd ?? 0,
    };
  }

  setGateIntent(shipId: string, verdict: "approve" | "reject", feedback?: string, commentUrl?: string): void {
    this.db.prepare(`
      INSERT INTO gate_intents (ship_id, verdict, feedback, comment_url, declared_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(ship_id) DO UPDATE SET
        verdict = excluded.verdict,
        feedback = excluded.feedback,
        comment_url = excluded.comment_url,
        declared_at = excluded.declared_at
    `).run(shipId, verdict, feedback ?? null, commentUrl ?? null);
  }

  getGateIntent(shipId: string): { verdict: "approve" | "reject"; feedback: string | null; commentUrl: string | null; declaredAt: string } | undefined {
    const row = this.db.prepare(
      "SELECT verdict, feedback, comment_url, declared_at FROM gate_intents WHERE ship_id = ?",
    ).get(shipId) as { verdict: string; feedback: string | null; comment_url: string | null; declared_at: string } | undefined;
    if (!row) return undefined;
    return {
      verdict: row.verdict as "approve" | "reject",
      feedback: row.feedback,
      commentUrl: row.comment_url,
      declaredAt: row.declared_at,
    };
  }

  clearGateIntent(shipId: string): void {
    this.db.prepare("DELETE FROM gate_intents WHERE ship_id = ?").run(shipId);
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
      cacheReadInputTokens: row.cache_read_input_tokens,
      cacheCreationInputTokens: row.cache_creation_input_tokens,
      costUsd: row.cost_usd,
    };
  }
}
