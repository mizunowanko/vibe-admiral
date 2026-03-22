import * as github from "./github.js";
import type { IssueStatus } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mapping between internal IssueStatus and GitHub label names.
 * Only two labels exist: status/ready and status/sortied.
 * "done" has no label — the issue is simply closed.
 */
const STATUS_TO_LABEL: ReadonlyMap<IssueStatus, string> = new Map([
  ["ready", "status/ready"],
  ["sortied", "status/sortied"],
  ["done", ""], // done = issue closed, no label
]);

/**
 * Allowed transitions: ready → sortied → done, and sortied → ready (rollback).
 */
const VALID_TRANSITIONS: ReadonlyMap<IssueStatus, readonly IssueStatus[]> =
  new Map([
    ["ready", ["sortied"]],
    ["sortied", ["done", "ready"]],
    ["done", []],
  ]);

/**
 * Centralized status manager for GitHub Issue labels.
 *
 * All status changes (ready/sortied/done) MUST go through this manager.
 * The GitHub Issue label is the single source of truth for issue status.
 *
 * Labels use the `status/` prefix: `status/ready` and `status/sortied`.
 * Per-phase labels have been removed — Ship phase is tracked in the local DB only.
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
    if (currentLabel === "status/sortied")
      return { status: "sortied", currentLabel };
    // Any other status/* label or no label → treat as ready
    return { status: "ready", currentLabel: currentLabel ?? undefined };
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
   * Mark an issue as "sortied" (sortie started). Convenience wrapper around transition.
   */
  async markSortied(repo: string, issueNumber: number): Promise<void> {
    await this.transition(repo, issueNumber, "sortied");
  }

  /**
   * Mark an issue as "done": remove status label and close the issue.
   */
  async markDone(repo: string, issueNumber: number): Promise<void> {
    await this.transition(repo, issueNumber, "done");
  }

  /**
   * Rollback an issue from "sortied" to "ready" with exponential backoff retry.
   */
  async rollback(
    repo: string,
    issueNumber: number,
    maxRetries = 3,
  ): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.transition(repo, issueNumber, "ready");
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
   * Check if an issue has "sortied" status (active sortie in progress).
   * Used by sortie guard.
   */
  async isSortied(repo: string, issueNumber: number): Promise<boolean> {
    const status = await this.getStatus(repo, issueNumber);
    return status === "sortied";
  }

  /**
   * Non-blocking label sync helper.
   * Applies a label to an issue, logging but not throwing on failure.
   * Useful for best-effort label updates that should not block the main flow.
   */
  async syncLabel(
    repo: string,
    issueNumber: number,
    label: string,
  ): Promise<void> {
    try {
      const currentLabel = await this.getCurrentStatusLabel(repo, issueNumber);
      if (currentLabel === label) return;
      await github.updateLabels(repo, issueNumber, {
        remove: currentLabel,
        add: label,
      });
    } catch (err) {
      console.warn(
        `[status-manager] Non-blocking label sync failed for #${issueNumber} (label=${label}):`,
        err,
      );
    }
  }

  private async applyTransition(
    repo: string,
    issueNumber: number,
    to: IssueStatus,
    currentLabel: string | undefined,
  ): Promise<void> {
    switch (to) {
      case "sortied": {
        // ready → sortied: remove "status/ready", add "status/sortied"
        await github.updateLabels(repo, issueNumber, {
          remove: currentLabel,
          add: STATUS_TO_LABEL.get("sortied"),
        });
        break;
      }
      case "ready": {
        // sortied → ready (rollback): remove current status/* label, add "status/ready"
        await github.updateLabels(repo, issueNumber, {
          remove: currentLabel,
          add: STATUS_TO_LABEL.get("ready"),
        });
        break;
      }
      case "done": {
        // sortied → done: remove current status/* label and close issue
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
