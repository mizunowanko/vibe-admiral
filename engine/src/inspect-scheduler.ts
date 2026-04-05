/**
 * InspectScheduler — Event-driven, debounced, batched ship-inspect Dispatch launcher.
 *
 * Instead of Flagship polling all Ships periodically and launching one Dispatch per Ship,
 * this scheduler:
 * 1. Receives enqueue() calls from phase-change and Lookout-alert handlers
 * 2. Debounces per-ship (minimum 3 minutes between inspects for the same Ship)
 * 3. Batches pending inspects into a single Dispatch after a short window (5 seconds)
 *
 * Resolves #868.
 */
import type { DispatchManager } from "./dispatch-manager.js";
import type { ShipManager } from "./ship-manager.js";

export type InspectTrigger = "phase-change" | "lookout-alert";

interface PendingInspect {
  shipId: string;
  fleetId: string;
  trigger: InspectTrigger;
  issueNumber: number;
  issueTitle: string;
  worktreePath: string;
}

const DEBOUNCE_MS = 3 * 60 * 1000; // 3 minutes per ship
const BATCH_WINDOW_MS = 5_000; // 5 seconds after first enqueue

export class InspectScheduler {
  private dispatchManager: DispatchManager;
  private shipManager: ShipManager;

  /** Last inspect timestamp per ship ID. */
  private lastInspectAt = new Map<string, number>();
  /** Pending inspects waiting for batch window to close. Key = shipId. */
  private pending = new Map<string, PendingInspect>();
  /** Timer for batch window. */
  private batchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dispatchManager: DispatchManager, shipManager: ShipManager) {
    this.dispatchManager = dispatchManager;
    this.shipManager = shipManager;
  }

  /**
   * Enqueue a ship for inspection. Debounces per-ship and batches across ships.
   */
  enqueue(shipId: string, fleetId: string, trigger: InspectTrigger): void {
    const now = Date.now();

    // Per-ship debounce: skip if inspected within DEBOUNCE_MS
    const lastInspect = this.lastInspectAt.get(shipId);
    if (lastInspect && now - lastInspect < DEBOUNCE_MS) {
      console.log(
        `[inspect-scheduler] Debounced ship ${shipId.slice(0, 8)}... (last inspect ${Math.round((now - lastInspect) / 1000)}s ago)`,
      );
      return;
    }

    // Get ship info for the Dispatch prompt
    const ship = this.shipManager.getShip(shipId);
    if (!ship) return;

    // Skip ships in terminal phases — no need to inspect
    if (ship.phase === "done" || ship.phase === "paused" || ship.phase === "abandoned") {
      return;
    }

    this.pending.set(shipId, {
      shipId,
      fleetId,
      trigger,
      issueNumber: ship.issueNumber,
      issueTitle: ship.issueTitle,
      worktreePath: ship.worktreePath,
    });

    // Start batch window if not already running
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => this.flush(), BATCH_WINDOW_MS);
    }
  }

  /**
   * Flush all pending inspects into a single Dispatch.
   */
  private flush(): void {
    this.batchTimer = null;

    if (this.pending.size === 0) return;

    const items = Array.from(this.pending.values());
    this.pending.clear();

    const now = Date.now();
    for (const item of items) {
      this.lastInspectAt.set(item.shipId, now);
    }

    // Use the first item's fleetId (all ships in a batch should belong to the same fleet)
    const fleetId = items[0]!.fleetId;

    // Build a multi-ship inspect prompt
    const shipSections = items.map((item) => {
      return `### Ship #${item.issueNumber} (${item.issueTitle})
- Ship ID: ${item.shipId}
- Trigger: ${item.trigger}
- Worktree: ${item.worktreePath}

Steps for this Ship:
1. Read ship chat log: \`tail -n 300 ${item.worktreePath}/.claude/ship-log.jsonl 2>/dev/null | grep '"type":"assistant"' | tail -n 30\`
   Also: \`tail -n 50 ${item.worktreePath}/.claude/ship-log.jsonl 2>/dev/null | grep '"type":"result"'\`
2. Read escort chat log: \`tail -n 200 ${item.worktreePath}/.claude/escort-log.jsonl 2>/dev/null | grep '"type":"assistant"' | tail -n 20\`
3. Read workflow state: \`cat ${item.worktreePath}/.claude/workflow-state.json 2>/dev/null || echo NO_STATE\``;
    }).join("\n\n");

    const prompt = `You are a Dispatch agent performing a batched ship-inspect. Read the chat logs of ALL listed Ships and report their status.

## Ships to Inspect (${items.length} total)

${shipSections}

## Instructions

For EACH Ship above, execute the steps in order using the Bash tool. Do NOT skip any step.

## Output Format

Report each Ship's status in this format:

\`\`\`
Ship #<issue-number> (<issue-title>)
- Phase activity: <what the Ship is actually doing based on chat log>
- Last actions: <2-3 most recent significant actions>
- Escort status: <gate review status or "no Escort">
- Workflow state: <current step and progress>
- Issues/Blockers: <errors, loops, stuck behavior, or "none">
\`\`\`

Do NOT create issues or make any changes. Only read and report.`;

    const name = items.length === 1
      ? `ship-inspect-${items[0]!.issueNumber}`
      : `ship-inspect-batch-${items.map((i) => i.issueNumber).join("-")}`;

    console.log(
      `[inspect-scheduler] Launching batch inspect Dispatch for ${items.length} ship(s): ${items.map((i) => `#${i.issueNumber}`).join(", ")}`,
    );

    this.dispatchManager.launch({
      fleetId,
      parentRole: "flagship",
      name,
      type: "investigate",
      cwd: items[0]!.worktreePath,
      prompt,
    });
  }

  /**
   * Clean up stale debounce entries for ships that are no longer active.
   */
  cleanupStaleEntries(activeShipIds: Set<string>): void {
    for (const shipId of this.lastInspectAt.keys()) {
      if (!activeShipIds.has(shipId)) {
        this.lastInspectAt.delete(shipId);
      }
    }
  }

  stop(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.pending.clear();
  }
}
