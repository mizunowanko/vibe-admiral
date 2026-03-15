import type { ShipManager } from "./ship-manager.js";
import type { StatusManager } from "./status-manager.js";
import * as github from "./github.js";
import * as worktree from "./worktree.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class StateSync {
  private shipManager: ShipManager;
  private statusManager: StatusManager;

  constructor(shipManager: ShipManager, statusManager: StatusManager) {
    this.shipManager = shipManager;
    this.statusManager = statusManager;
  }

  /**
   * Pre-sortie validation: check for duplicate ships, existing worktrees,
   * and status/* labels that indicate an issue is already in progress.
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

    // 2. Check if issue already has an active status (not status/todo)
    try {
      if (await this.statusManager.isDoing(repo, issueNumber)) {
        return {
          ok: false,
          reason: `Issue #${issueNumber} already has an active status label`,
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
   * Rollback issue status to "status/todo" via StatusManager.
   */
  async rollbackLabel(
    repo: string,
    issueNumber: number,
    maxRetries = 3,
  ): Promise<void> {
    await this.statusManager.rollback(repo, issueNumber, maxRetries);
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
      // Successful completion: remove worktree, mark done (label + close issue)
      await this.removeWorktreeWithRetry(ship.worktreePath);

      try {
        await this.statusManager.markDone(ship.repo, ship.issueNumber);
      } catch (err) {
        console.warn(
          `[state-sync] Failed to mark #${ship.issueNumber} as done:`,
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
   * Startup reconciliation: audit "doing" labels and orphan worktrees.
   * Called once when Engine starts.
   */
  async reconcileOnStartup(
    repos: Array<{ remote?: string; localPath: string }>,
  ): Promise<void> {
    console.log("[state-sync] Running startup reconciliation...");

    const activeIssues = this.shipManager.getActiveShipIssueNumbers();

    for (const repo of repos) {
      if (!repo.remote) continue;

      // 1. Audit active status/* labels: if no active Ship, roll back to "status/todo"
      const activeStatusLabels = [
        "status/investigating",
        "status/planning",
        "status/implementing",
        "status/testing",
        "status/reviewing",
        "status/acceptance-test",
        "status/merging",
      ];
      try {
        for (const label of activeStatusLabels) {
          const labeledIssues = await github.listIssues(repo.remote, label);
          for (const issue of labeledIssues) {
            if (!activeIssues.includes(issue.number)) {
              console.warn(
                `[state-sync] Orphan "${label}" label on #${issue.number} — rolling back to "status/todo"`,
              );
              await this.rollbackLabel(repo.remote, issue.number);
            }
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
