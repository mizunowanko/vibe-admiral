import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ShipProcess, Phase, EscortProcess } from "./types.js";
import { ShipRepo } from "./repo/ship-repo.js";
import { PhaseRepo } from "./repo/phase-repo.js";
import { ChatLogRepo } from "./repo/chat-log-repo.js";
import { EscortRepo } from "./repo/escort-repo.js";
import { SnapshotRepo } from "./repo/snapshot-repo.js";

export type { ShipRow } from "./repo/ship-repo.js";
export type { EscortRow } from "./repo/escort-repo.js";

export class FleetDatabase {
  private db: Database.Database;
  readonly ships: ShipRepo;
  readonly phases: PhaseRepo;
  readonly chatLogs: ChatLogRepo;
  readonly escorts: EscortRepo;
  readonly snapshots: SnapshotRepo;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();

    this.ships = new ShipRepo(this.db);
    this.phases = new PhaseRepo(this.db);
    this.chatLogs = new ChatLogRepo(this.db);
    this.escorts = new EscortRepo(this.db);
    this.snapshots = new SnapshotRepo(this.db);
  }

  private migrate(): void {
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
    if (version < 13) {
      this.applyV13();
    }
    if (version < 14) {
      this.applyV14();
    }
    if (version < 15) {
      this.applyV15();
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
    this.db.exec(`
      ALTER TABLE ships RENAME COLUMN status TO phase;

      UPDATE ships SET phase = 'planning' WHERE phase = 'error';

      CREATE INDEX IF NOT EXISTS idx_messages_ship_unread
        ON messages (ship_id, type, read_at);

      INSERT INTO schema_version (version) VALUES (2);
    `);
  }

  private applyV3(): void {
    this.db.exec(`
      DROP INDEX IF EXISTS idx_messages_ship_unread;
      DROP TABLE IF EXISTS messages;

      INSERT INTO schema_version (version) VALUES (3);
    `);
  }

  private applyV4(): void {
    this.db.exec(`
      ALTER TABLE ships ADD COLUMN kind TEXT NOT NULL DEFAULT 'ship';
      ALTER TABLE ships ADD COLUMN parent_ship_id TEXT;

      DROP INDEX IF EXISTS idx_ships_repo_issue;
      CREATE UNIQUE INDEX idx_ships_repo_issue_kind ON ships (repo_id, issue_number, kind);

      INSERT INTO schema_version (version) VALUES (4);
    `);
  }

  private applyV5(): void {
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
    this.db.pragma("foreign_keys = OFF");

    try {
      this.db.exec(`
        DROP TABLE IF EXISTS ships_new;
        DROP TABLE IF EXISTS escorts;

        BEGIN;

        CREATE TABLE escorts (
          id TEXT PRIMARY KEY,
          ship_id TEXT NOT NULL,
          session_id TEXT,
          process_pid INTEGER,
          phase TEXT NOT NULL DEFAULT 'planning',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT
        );

        INSERT INTO escorts (id, ship_id, session_id, process_pid, phase, created_at, completed_at)
        SELECT id, parent_ship_id, session_id, process_pid, phase, created_at, completed_at
        FROM ships WHERE kind = 'escort' AND parent_ship_id IS NOT NULL;

        DELETE FROM phase_transitions WHERE ship_id IN (
          SELECT id FROM ships WHERE kind = 'escort'
        );
        DELETE FROM phases WHERE ship_id IN (
          SELECT id FROM ships WHERE kind = 'escort'
        );

        DELETE FROM ships WHERE kind = 'escort';

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

        CREATE UNIQUE INDEX idx_ships_repo_issue ON ships (repo_id, issue_number);

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
    this.db.exec(`
      UPDATE ships SET phase = 'paused' WHERE phase = 'stopped';
      UPDATE phases SET phase = 'paused' WHERE phase = 'stopped';

      INSERT INTO schema_version (version) VALUES (10);
    `);
  }

  private applyV11(): void {
    this.db.exec(`
      ALTER TABLE ships ADD COLUMN actor_snapshot TEXT;

      INSERT INTO schema_version (version) VALUES (11);
    `);
  }

  private applyV12(): void {
    this.db.exec(`
      ALTER TABLE escorts ADD COLUMN total_input_tokens INTEGER;
      ALTER TABLE escorts ADD COLUMN total_output_tokens INTEGER;
      ALTER TABLE escorts ADD COLUMN cost_usd REAL;

      INSERT INTO schema_version (version) VALUES (12);
    `);
  }

  private applyV13(): void {
    this.db.exec(`
      ALTER TABLE escorts ADD COLUMN cache_read_input_tokens INTEGER;
      ALTER TABLE escorts ADD COLUMN cache_creation_input_tokens INTEGER;

      INSERT INTO schema_version (version) VALUES (13);
    `);
  }

  private applyV14(): void {
    this.db.exec(`
      ALTER TABLE repos ADD COLUMN fleet_id TEXT;

      INSERT INTO schema_version (version) VALUES (14);
    `);
  }

  private applyV15(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gate_intents (
        ship_id TEXT PRIMARY KEY REFERENCES ships(id),
        verdict TEXT NOT NULL CHECK(verdict IN ('approve', 'reject')),
        feedback TEXT,
        comment_url TEXT,
        declared_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO schema_version (version) VALUES (15);
    `);
  }

  // === Facade methods — delegate to repos ===

  ensureRepo(owner: string, name: string, fleetId?: string): number {
    return this.ships.ensureRepo(owner, name, fleetId);
  }

  upsertShip(ship: ShipProcess): void {
    this.ships.upsertShip(ship);
  }

  updateShipPhase(shipId: string, phase: Phase, completedAt?: number): void {
    this.ships.updateShipPhase(shipId, phase, completedAt);
  }

  updateShipSessionId(shipId: string, sessionId: string | null): void {
    this.ships.updateShipSessionId(shipId, sessionId);
  }

  deleteShip(shipId: string): void {
    this.ships.deleteShip(shipId);
  }

  transferTransitionsForReSortie(oldShipId: string, newShipId: string): void {
    this.ships.transferTransitionsForReSortie(oldShipId, newShipId);
  }

  getActiveShips(): ShipProcess[] {
    return this.ships.getActiveShips();
  }

  getAllShips(): ShipProcess[] {
    return this.ships.getAllShips();
  }

  getShipsByFleet(fleetId: string): ShipProcess[] {
    return this.ships.getShipsByFleet(fleetId);
  }

  getShipById(shipId: string): ShipProcess | undefined {
    return this.ships.getShipById(shipId);
  }

  getShipByIssue(repo: string, issueNumber: number, fleetId?: string): ShipProcess | undefined {
    return this.ships.getShipByIssue(repo, issueNumber, fleetId);
  }

  getShipByIssueAnyPhase(repo: string, issueNumber: number, fleetId?: string): ShipProcess | undefined {
    return this.ships.getShipByIssueAnyPhase(repo, issueNumber, fleetId);
  }

  getActiveShipIssueNumbers(): Array<{ repo: string; issueNumber: number }> {
    return this.ships.getActiveShipIssueNumbers();
  }

  persistPhaseTransition(
    shipId: string,
    expectedPhase: Phase,
    newPhase: Phase,
    triggeredBy: string,
    metadata?: Record<string, unknown>,
    actorSnapshot?: unknown,
  ): boolean {
    return this.phases.persistPhaseTransition(shipId, expectedPhase, newPhase, triggeredBy, metadata, actorSnapshot);
  }

  getPhaseBeforeStopped(shipId: string): Phase | null {
    return this.phases.getPhaseBeforeStopped(shipId);
  }

  recordPhaseTransition(
    shipId: string,
    fromPhase: string | null,
    toPhase: string,
    triggeredBy: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.phases.recordPhaseTransition(shipId, fromPhase, toPhase, triggeredBy, metadata);
  }

  getPhaseTransitions(shipId: string, limit: number = 10): Array<Record<string, unknown>> {
    return this.phases.getPhaseTransitions(shipId, limit);
  }

  purgeTerminalShips(): number {
    return this.phases.purgeTerminalShips((shipId) => this.ships.deleteShip(shipId));
  }

  saveChatLog(
    shipId: string,
    logType: "ship" | "escort",
    compressedData: Buffer,
    messageCount: number,
    rawByteSize: number,
  ): void {
    this.chatLogs.saveChatLog(shipId, logType, compressedData, messageCount, rawByteSize);
  }

  getChatLogs(shipId: string): Array<{ logType: string; data: Buffer; messageCount: number }> {
    return this.chatLogs.getChatLogs(shipId);
  }

  hasChatLogs(shipId: string): boolean {
    return this.chatLogs.hasChatLogs(shipId);
  }

  upsertEscort(escort: EscortProcess): void {
    this.escorts.upsertEscort(escort);
  }

  getEscortById(id: string): EscortProcess | undefined {
    return this.escorts.getEscortById(id);
  }

  getEscortByShipId(shipId: string): EscortProcess | undefined {
    return this.escorts.getEscortByShipId(shipId);
  }

  updateEscortPhase(id: string, phase: string, completedAt?: string): void {
    this.escorts.updateEscortPhase(id, phase, completedAt);
  }

  updateEscortSessionId(id: string, sessionId: string | null): void {
    this.escorts.updateEscortSessionId(id, sessionId);
  }

  deleteEscort(id: string): void {
    this.escorts.deleteEscort(id);
  }

  updateEscortUsage(
    id: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadInputTokens: number,
    cacheCreationInputTokens: number,
    costUsd: number,
  ): void {
    this.escorts.updateEscortUsage(id, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUsd);
  }

  getEscortUsageByShipId(shipId: string): {
    totalInputTokens: number;
    totalOutputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    costUsd: number;
  } | null {
    return this.escorts.getEscortUsageByShipId(shipId);
  }

  getActorSnapshot(shipId: string): unknown | null {
    return this.snapshots.getActorSnapshot(shipId);
  }

  updateActorSnapshot(shipId: string, snapshot: unknown): void {
    this.snapshots.updateActorSnapshot(shipId, snapshot);
  }

  setGateIntent(shipId: string, verdict: "approve" | "reject", feedback?: string, commentUrl?: string): void {
    this.escorts.setGateIntent(shipId, verdict, feedback, commentUrl);
  }

  getGateIntent(shipId: string): { verdict: "approve" | "reject"; feedback: string | null; commentUrl: string | null; declaredAt: string } | undefined {
    return this.escorts.getGateIntent(shipId);
  }

  clearGateIntent(shipId: string): void {
    this.escorts.clearGateIntent(shipId);
  }

  close(): void {
    this.db.close();
  }

  get path(): string {
    return this.db.name;
  }
}

export async function initFleetDatabase(dbDir: string): Promise<FleetDatabase> {
  await mkdir(dbDir, { recursive: true });
  const dbPath = join(dbDir, "fleet.db");
  return new FleetDatabase(dbPath);
}
