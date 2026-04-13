import type Database from "better-sqlite3";
import { safeJsonParse } from "../util/json-safe.js";

export class SnapshotRepo {
  constructor(private db: Database.Database) {}

  getActorSnapshot(shipId: string): unknown | null {
    const row = this.db.prepare(
      "SELECT actor_snapshot FROM ships WHERE id = ?",
    ).get(shipId) as { actor_snapshot: string | null } | undefined;
    if (!row?.actor_snapshot) return null;
    return safeJsonParse(row.actor_snapshot, "actor-snapshot", null);
  }

  updateActorSnapshot(shipId: string, snapshot: unknown): void {
    this.db.prepare(
      "UPDATE ships SET actor_snapshot = ? WHERE id = ?",
    ).run(JSON.stringify(snapshot), shipId);
  }
}
