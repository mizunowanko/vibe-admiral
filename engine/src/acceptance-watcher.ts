import { watch, type FSWatcher } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { AcceptanceTestRequest } from "./types.js";

export interface AcceptanceTestResponse {
  accepted: boolean;
  feedback?: string;
}

export class AcceptanceWatcher extends EventEmitter {
  private watchers = new Map<string, FSWatcher>();

  watch(worktreePath: string, shipId: string): void {
    const claudeDir = join(worktreePath, ".claude");
    const requestFile = join(claudeDir, "acceptance-test-request.json");

    // Ensure .claude directory exists
    mkdir(claudeDir, { recursive: true }).catch(() => {});

    try {
      const watcher = watch(claudeDir, async (eventType, filename) => {
        if (filename !== "acceptance-test-request.json") return;
        if (eventType !== "rename" && eventType !== "change") return;

        try {
          const content = await readFile(requestFile, "utf-8");
          const request = JSON.parse(content) as AcceptanceTestRequest;
          this.emit("request", shipId, request);
        } catch {
          // File might not be fully written yet
        }
      });

      this.watchers.set(shipId, watcher);
    } catch {
      // Directory might not exist yet, will be created later
    }
  }

  async respond(
    worktreePath: string,
    response: AcceptanceTestResponse,
  ): Promise<void> {
    const responseFile = join(
      worktreePath,
      ".claude",
      "acceptance-test-response.json",
    );
    await writeFile(responseFile, JSON.stringify(response, null, 2));
  }

  unwatch(shipId: string): void {
    const watcher = this.watchers.get(shipId);
    if (watcher) {
      watcher.close();
      this.watchers.delete(shipId);
    }
  }

  unwatchAll(): void {
    for (const [id, watcher] of this.watchers) {
      watcher.close();
      this.watchers.delete(id);
    }
  }
}
