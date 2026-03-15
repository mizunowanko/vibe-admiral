import * as github from "./github.js";
import type { IssueStatus } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    const issue = await github.getIssue(repo, issueNumber);
    if (issue.state === "closed") return "done";
    if (issue.labels.includes("doing")) return "doing";
    if (issue.labels.includes("todo")) return "todo";
    // No recognized label — default to todo
    return "todo";
  }

  /**
   * Transition an issue from one status to another.
   * Validates the transition and updates GitHub labels atomically.
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
      const from = await this.getStatus(repo, issueNumber);
      if (from === to) return; // no-op

      const allowed = VALID_TRANSITIONS.get(from);
      if (!allowed?.includes(to)) {
        throw new Error(
          `Invalid status transition for #${issueNumber}: ${from} → ${to}`,
        );
      }

      await this.applyTransition(repo, issueNumber, to);
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
   * Mark an issue as "done": remove "doing" label and close the issue.
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
   * Check if an issue has "doing" status. Used by sortie guard.
   */
  async isDoing(repo: string, issueNumber: number): Promise<boolean> {
    const status = await this.getStatus(repo, issueNumber);
    return status === "doing";
  }

  private async applyTransition(
    repo: string,
    issueNumber: number,
    to: IssueStatus,
  ): Promise<void> {
    switch (to) {
      case "doing": {
        // todo → doing: remove "todo", add "doing"
        await github.updateLabels(repo, issueNumber, {
          remove: "todo",
          add: "doing",
        });
        break;
      }
      case "todo": {
        // doing → todo (rollback): remove "doing", add "todo"
        await github.updateLabels(repo, issueNumber, {
          remove: "doing",
          add: "todo",
        });
        break;
      }
      case "done": {
        // doing → done: remove "doing" label and close issue
        await github.updateLabels(repo, issueNumber, {
          remove: "doing",
        });
        await github.closeIssue(repo, issueNumber);
        break;
      }
    }
  }
}
