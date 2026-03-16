import * as github from "./github.js";
import type { IssueStatus, ShipStatus } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mapping between internal IssueStatus and GitHub label names.
 */
const STATUS_TO_LABEL: ReadonlyMap<IssueStatus, string> = new Map([
  ["todo", "status/todo"],
  ["doing", "status/implementing"],
  ["done", ""], // done = issue closed, no label
]);

/**
 * Mapping from ShipStatus (phase) to GitHub label name.
 * Phases that don't map to a label are omitted.
 */
const PHASE_TO_LABEL: ReadonlyMap<ShipStatus, string> = new Map([
  ["investigating", "status/investigating"],
  ["planning", "status/planning"],
  ["implementing", "status/implementing"],
  ["testing", "status/testing"],
  ["reviewing", "status/reviewing"],
  ["acceptance-test", "status/acceptance-test"],
  ["merging", "status/merging"],
]);

/**
 * Allowed transitions: todo → doing → done, and doing → todo (rollback).
 */
const VALID_TRANSITIONS: ReadonlyMap<IssueStatus, readonly IssueStatus[]> =
  new Map([
    ["todo", ["doing"]],
    ["doing", ["done", "todo"]],
    ["done", []],
  ]);

/**
 * Centralized status manager for GitHub Issue labels.
 *
 * All status changes (todo/doing/done) MUST go through this manager.
 * The GitHub Issue label is the single source of truth for issue status.
 *
 * Labels use the `status/` prefix (e.g. `status/todo`, `status/implementing`).
 * Ship phase changes are synced to GitHub via `syncPhaseLabel()`.
 */
export class StatusManager {
  /** Guard against concurrent transitions for the same issue. */
  private pending = new Set<string>();

  private issueKey(repo: string, issueNumber: number): string {
    return `${repo}#${issueNumber}`;
  }

  /**
   * Read current issue status from GitHub labels.
   */
  async getStatus(repo: string, issueNumber: number): Promise<IssueStatus> {
    return (await this.getStatusInfo(repo, issueNumber)).status;
  }

  /**
   * Get the current status/* label on an issue, if any.
   */
  async getCurrentStatusLabel(
    repo: string,
    issueNumber: number,
  ): Promise<string | undefined> {
    return (await this.getStatusInfo(repo, issueNumber)).currentLabel;
  }

  /**
   * Internal: fetch issue once and derive both status and current label.
   */
  private async getStatusInfo(
    repo: string,
    issueNumber: number,
  ): Promise<{ status: IssueStatus; currentLabel: string | undefined }> {
    const issue = await github.getIssue(repo, issueNumber);
    const currentLabel = issue.labels.find((l) => l.startsWith("status/"));
    if (issue.state === "closed") return { status: "done", currentLabel };
    if (currentLabel === "status/todo") return { status: "todo", currentLabel };
    if (currentLabel) return { status: "doing", currentLabel };
    return { status: "todo", currentLabel: undefined };
  }

  /**
   * Transition an issue from one status to another.
   * Validates the transition and updates GitHub labels.
   */
  async transition(
    repo: string,
    issueNumber: number,
    to: IssueStatus,
  ): Promise<void> {
    const key = this.issueKey(repo, issueNumber);
    if (this.pending.has(key)) {
      throw new Error(
        `Concurrent status transition for ${key} — please wait for the previous operation`,
      );
    }

    this.pending.add(key);
    try {
      const { status: from, currentLabel } = await this.getStatusInfo(
        repo,
        issueNumber,
      );
      if (from === to) return; // no-op

      const allowed = VALID_TRANSITIONS.get(from);
      if (!allowed?.includes(to)) {
        throw new Error(
          `Invalid status transition for #${issueNumber}: ${from} → ${to}`,
        );
      }

      await this.applyTransition(repo, issueNumber, to, currentLabel);
    } finally {
      this.pending.delete(key);
    }
  }

  /**
   * Mark an issue as "doing" (sortie). Convenience wrapper around transition.
   */
  async markDoing(repo: string, issueNumber: number): Promise<void> {
    await this.transition(repo, issueNumber, "doing");
  }

  /**
   * Mark an issue as "done": remove status label and close the issue.
   */
  async markDone(repo: string, issueNumber: number): Promise<void> {
    await this.transition(repo, issueNumber, "done");
  }

  /**
   * Rollback an issue from "doing" to "todo" with exponential backoff retry.
   */
  async rollback(
    repo: string,
    issueNumber: number,
    maxRetries = 3,
  ): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.transition(repo, issueNumber, "todo");
        return;
      } catch (err) {
        if (attempt === maxRetries) {
          console.error(
            `[status-manager] Failed to rollback #${issueNumber} after ${maxRetries + 1} attempts:`,
            err,
          );
          return;
        }
        const delay = 500 * Math.pow(2, attempt);
        console.warn(
          `[status-manager] Rollback attempt ${attempt + 1} failed for #${issueNumber}, retrying in ${delay}ms`,
        );
        await sleep(delay);
      }
    }
  }

  /**
   * Check if an issue has "doing" status (any active status/* label except status/todo).
   * Used by sortie guard.
   */
  async isDoing(repo: string, issueNumber: number): Promise<boolean> {
    const status = await this.getStatus(repo, issueNumber);
    return status === "doing";
  }

  /**
   * Sync Ship phase to GitHub Issue label.
   * Replaces the current status/* label with the one matching the new phase.
   *
   * Throws on failure so callers (e.g. ShipRequestHandler) can enforce
   * transactional guarantees — internal state is only updated after label sync succeeds.
   */
  async syncPhaseLabel(
    repo: string,
    issueNumber: number,
    phase: ShipStatus,
  ): Promise<void> {
    const newLabel = PHASE_TO_LABEL.get(phase);
    if (!newLabel) return; // done/error don't get a phase label

    const currentLabel = await this.getCurrentStatusLabel(repo, issueNumber);
    if (currentLabel === newLabel) return; // already correct

    await github.updateLabels(repo, issueNumber, {
      remove: currentLabel,
      add: newLabel,
    });
  }

  private async applyTransition(
    repo: string,
    issueNumber: number,
    to: IssueStatus,
    currentLabel: string | undefined,
  ): Promise<void> {
    switch (to) {
      case "doing": {
        // todo → doing: remove "status/todo", add "status/implementing"
        await github.updateLabels(repo, issueNumber, {
          remove: currentLabel,
          add: STATUS_TO_LABEL.get("doing"),
        });
        break;
      }
      case "todo": {
        // doing → todo (rollback): remove current status/* label, add "status/todo"
        await github.updateLabels(repo, issueNumber, {
          remove: currentLabel,
          add: STATUS_TO_LABEL.get("todo"),
        });
        break;
      }
      case "done": {
        // doing → done: remove current status/* label and close issue
        if (currentLabel) {
          await github.updateLabels(repo, issueNumber, {
            remove: currentLabel,
          });
        }
        await github.closeIssue(repo, issueNumber);
        break;
      }
    }
  }
}
