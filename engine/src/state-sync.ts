import type { ShipManager } from "./ship-manager.js";
import * as github from "./github.js";
import * as worktree from "./worktree.js";

/** status/* labels that indicate work-in-progress (not todo, not blocked). */
const ACTIVE_STATUS_LABELS = new Set([
  "status/investigating",
  "status/planning",
  "status/implementing",
  "status/testing",
  "status/reviewing",
  "status/acceptance-test",
  "status/merging",
]);

function getActiveStatusLabel(labels: string[]): string | undefined {
  return labels.find((l) => ACTIVE_STATUS_LABELS.has(l));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class StateSync {
  private shipManager: ShipManager;

  constructor(shipManager: ShipManager) {
    this.shipManager = shipManager;
  }

  /**
   * Pre-sortie validation: check for duplicate ships, existing worktrees,
   * and doing labels that indicate an issue is already in progress.
   */
  async sortieGuard(
    repo: string,
    issueNumber: number,
  ): Promise<{ ok: boolean; reason?: string }> {
    // 1. Check if a Ship is already running for this issue
    const existing = this.shipManager.getShipByIssue(issueNumber);
    if (existing) {
      return {
        ok: false,
        reason: `Issue #${issueNumber} already has an active Ship (${existing.id.slice(0, 8)}..., status: ${existing.status})`,
      };
    }

    // 2. Check if issue already has an active status/* label (in progress)
    try {
      const issue = await github.getIssue(repo, issueNumber);
      const activeLabel = getActiveStatusLabel(issue.labels);
      if (activeLabel) {
        return {
          ok: false,
          reason: `Issue #${issueNumber} already has an active status label (${activeLabel})`,
        };
      }
    } catch (err) {
      return {
        ok: false,
        reason: `Failed to fetch issue #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return { ok: true };
  }

  /**
   * Rollback active status/* label to status/todo with exponential backoff retry.
   * Fetches the issue to find the current active label, then swaps it.
   */
  async rollbackLabel(
    repo: string,
    issueNumber: number,
    maxRetries = 3,
  ): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const issue = await github.getIssue(repo, issueNumber);
        const activeLabel = getActiveStatusLabel(issue.labels);
        if (!activeLabel) {
          // No active label to rollback — might already be status/todo
          if (!issue.labels.includes("status/todo")) {
            await github.updateLabels(repo, issueNumber, {
              add: "status/todo",
            });
          }
          return;
        }
        await github.updateLabels(repo, issueNumber, {
          remove: activeLabel,
          add: "status/todo",
        });
        return;
      } catch (err) {
        if (attempt === maxRetries) {
          console.error(
            `[state-sync] Failed to rollback labels for #${issueNumber} after ${maxRetries + 1} attempts:`,
            err,
          );
          return;
        }
        const delay = 500 * Math.pow(2, attempt);
        console.warn(
          `[state-sync] Label rollback attempt ${attempt + 1} failed for #${issueNumber}, retrying in ${delay}ms`,
        );
        await sleep(delay);
      }
    }
  }

  /**
   * Remove worktree with retry, falling back to forceRemove on failure.
   */
  async removeWorktreeWithRetry(
    worktreePath: string,
    maxRetries = 3,
  ): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await worktree.remove(worktreePath);
        return;
      } catch (err) {
        if (attempt === maxRetries) {
          console.warn(
            `[state-sync] Normal worktree remove failed after ${maxRetries + 1} attempts, trying force remove`,
          );
          try {
            await worktree.forceRemove(worktreePath);
          } catch (forceErr) {
            console.error(
              `[state-sync] Force worktree remove also failed for ${worktreePath}:`,
              forceErr,
            );
          }
          return;
        }
        const delay = 500 * Math.pow(2, attempt);
        console.warn(
          `[state-sync] Worktree remove attempt ${attempt + 1} failed, retrying in ${delay}ms:`,
          err,
        );
        await sleep(delay);
      }
    }
  }

  /**
   * Handle process exit: clean up worktree & labels based on success/failure.
   */
  async onProcessExit(shipId: string, succeeded: boolean): Promise<void> {
    const ship = this.shipManager.getShip(shipId);
    if (!ship) return;

    if (succeeded) {
      // Successful completion: remove worktree, remove active status/* label, mark done
      await this.removeWorktreeWithRetry(ship.worktreePath);

      try {
        const issue = await github.getIssue(ship.repo, ship.issueNumber);
        const activeLabel = getActiveStatusLabel(issue.labels);
        if (activeLabel) {
          await github.updateLabels(ship.repo, ship.issueNumber, {
            remove: activeLabel,
          });
        }
      } catch (err) {
        console.warn(
          `[state-sync] Failed to remove active status label for #${ship.issueNumber}:`,
          err,
        );
      }

      this.shipManager.updateStatus(shipId, "done");
    } else {
      // Failed: rollback doing→todo, mark error
      await this.rollbackLabel(ship.repo, ship.issueNumber);
      this.shipManager.updateStatus(shipId, "error", "Process failed");
    }
  }

  /**
   * Startup reconciliation: audit active status/* labels and orphan worktrees.
   * Called once when Engine starts.
   */
  async reconcileOnStartup(
    repos: Array<{ remote?: string; localPath: string }>,
  ): Promise<void> {
    console.log("[state-sync] Running startup reconciliation...");

    const activeIssues = this.shipManager.getActiveShipIssueNumbers();

    for (const repo of repos) {
      if (!repo.remote) continue;

      // 1. Audit active status/* labels: if no active Ship, roll back to status/todo
      try {
        const allIssues = await github.listIssues(repo.remote);
        const inProgressIssues = allIssues.filter((i) =>
          i.labels.some((l) => ACTIVE_STATUS_LABELS.has(l)),
        );
        for (const issue of inProgressIssues) {
          if (!activeIssues.includes(issue.number)) {
            const activeLabel = getActiveStatusLabel(issue.labels);
            console.warn(
              `[state-sync] Orphan "${activeLabel}" label on #${issue.number} — rolling back to "status/todo"`,
            );
            await this.rollbackLabel(repo.remote, issue.number);
          }
        }
      } catch (err) {
        console.warn(
          `[state-sync] Failed to audit status labels for ${repo.remote}:`,
          err,
        );
      }

      // 2. Clean up orphan feature worktrees
      try {
        const repoRoot = await worktree.getRepoRoot(repo.localPath);
        const featureWorktrees = await worktree.listFeatureWorktrees(repoRoot);
        for (const wt of featureWorktrees) {
          // Extract issue number from branch name: feature/<num>-<slug>
          const match = wt.branch?.match(/^feature\/(\d+)-/);
          if (!match) continue;
          const issueNum = Number(match[1]);
          if (!activeIssues.includes(issueNum)) {
            console.warn(
              `[state-sync] Orphan worktree for #${issueNum} at ${wt.path} — removing`,
            );
            await this.removeWorktreeWithRetry(wt.path);
          }
        }
      } catch (err) {
        console.warn(
          `[state-sync] Failed to audit worktrees for ${repo.localPath}:`,
          err,
        );
      }
    }

    console.log("[state-sync] Startup reconciliation complete.");
  }
}
