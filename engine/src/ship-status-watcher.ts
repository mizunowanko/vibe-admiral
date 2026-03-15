import { watch, type FSWatcher } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ShipStatus } from "./types.js";

const STATUS_FILE = "ship-status.json";

/** Valid phases that Ship can declare via the file message board. */
const DECLARABLE_PHASES: ReadonlySet<ShipStatus> = new Set([
  "investigating",
  "planning",
  "implementing",
  "testing",
  "reviewing",
  "acceptance-test",
  "merging",
]);

/**
 * Watches `.claude/ship-status.json` for phase declarations from Ship (Claude CLI).
 *
 * Ship writes `{ "phase": "<ShipStatus>" }` to declare its current phase.
 * This watcher detects the file and emits a "phase" event with the shipId and phase.
 */
export class ShipStatusWatcher extends EventEmitter {
  private watchers = new Map<string, FSWatcher>();

  watch(worktreePath: string, shipId: string): void {
    const claudeDir = join(worktreePath, ".claude");

    // Ensure .claude directory exists
    mkdir(claudeDir, { recursive: true }).catch(() => {});

    try {
      const watcher = watch(claudeDir, async (eventType, filename) => {
        if (filename !== STATUS_FILE) return;
        if (eventType !== "rename" && eventType !== "change") return;

        try {
          const content = await readFile(
            join(claudeDir, STATUS_FILE),
            "utf-8",
          );
          const data = JSON.parse(content) as { phase?: string };
          const phase = data.phase as ShipStatus | undefined;
          if (phase && DECLARABLE_PHASES.has(phase)) {
            this.emit("phase", shipId, phase);
          }
        } catch {
          // File might not be fully written yet — ignore
        }
      });

      this.watchers.set(shipId, watcher);
    } catch {
      // Directory might not exist yet, will be created later
    }
  }

  unwatch(shipId: string): void {
    const watcher = this.watchers.get(shipId);
    if (watcher) {
      watcher.close();
      this.watchers.delete(shipId);
    }
  }

  unwatchAll(): void {
    for (const [, watcher] of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();
  }
}
