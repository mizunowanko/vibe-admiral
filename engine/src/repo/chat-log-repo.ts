import type Database from "better-sqlite3";

export class ChatLogRepo {
  constructor(private db: Database.Database) {}

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

  hasChatLogs(shipId: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM chat_logs WHERE ship_id = ? LIMIT 1",
    ).get(shipId) as { 1: number } | undefined;
    return !!row;
  }
}
