import type { ShipManager } from "./ship-manager.js";
import type { StatusManager } from "./status-manager.js";
import * as github from "./github.js";
import * as worktree from "./worktree.js";
import { parseDependsOnLabels } from "./github.js";

/** status/* labels that indicate work-in-progress (not todo, not blocked). */
export const ACTIVE_STATUS_LABELS = new Set([
  "status/investigating",
  "status/planning",
  "status/implementing",
  "status/testing",
  "status/reviewing",
  "status/acceptance-test",
  "status/merging",
]);

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
   * and active status/* labels that indicate an issue is already in progress.
   */
  async sortieGuard(
    repo: string,
    issueNumber: number,
  ): Promise<{ ok: boolean; reason?: string }> {
    // 1. Check if a Ship is already running for this issue
    const existing = this.shipManager.getShipByIssue(repo, issueNumber);
    if (existing) {
      return {
        ok: false,
        reason: `Issue #${issueNumber} already has an active Ship (${existing.id.slice(0, 8)}..., status: ${existing.status})`,
      };
    }

    // 2. Check issue state: must be open and in "todo" status
    try {
      const status = await this.statusManager.getStatus(repo, issueNumber);
      if (status === "done") {
        return {
          ok: false,
          reason: `Issue #${issueNumber} is already closed`,
        };
      }
      if (status === "doing") {
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
   * Accepts an optional repoRoot so that removal works even if the
   * worktree directory has already been deleted.
   */
  async removeWorktreeWithRetry(
    worktreePath: string,
    maxRetries = 3,
    repoRoot?: string,
  ): Promise<void> {
    // Pre-resolve repoRoot so that later retries and forceRemove
    // don't fail if the worktree directory disappears mid-cleanup.
    const resolvedRoot = repoRoot ?? await worktree.getRepoRoot(worktreePath).catch(() => undefined);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await worktree.remove(worktreePath, resolvedRoot);
        return;
      } catch (err) {
        if (attempt === maxRetries) {
          console.warn(
            `[state-sync] Normal worktree remove failed after ${maxRetries + 1} attempts, trying force remove`,
          );
          try {
            await worktree.forceRemove(worktreePath, resolvedRoot);
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

    // Clear compacting flag — process is gone, no more compact events
    ship.isCompacting = false;

    if (succeeded) {
      // Update in-memory status immediately so ship-status queries return
      // the correct state while async GitHub operations are in progress.
      this.shipManager.updateStatus(shipId, "done");

      // Successful completion: remove worktree, mark done (label + close issue)
      await this.removeWorktreeWithRetry(ship.worktreePath);

      // Skip markDone if Ship already handled issue closure (nothing-to-do case)
      if (!ship.nothingToDo) {
        // Retry markDone with exponential backoff for consistency with failure path
        for (let attempt = 0; attempt <= 3; attempt++) {
          try {
            await this.statusManager.markDone(ship.repo, ship.issueNumber);
            break;
          } catch (err) {
            if (attempt === 3) {
              console.warn(
                `[state-sync] Failed to mark #${ship.issueNumber} as done after ${attempt + 1} attempts:`,
                err,
              );
            } else {
              const delay = 500 * Math.pow(2, attempt);
              console.warn(
                `[state-sync] markDone attempt ${attempt + 1} failed for #${ship.issueNumber}, retrying in ${delay}ms`,
              );
              await sleep(delay);
            }
          }
        }
      }

      // Audit depends-on/ labels: unblock issues that depended on the closed issue
      try {
        await this.auditDependencies(ship.repo, ship.issueNumber);
      } catch (err) {
        console.warn(
          `[state-sync] Failed to audit dependencies for #${ship.issueNumber}:`,
          err,
        );
      }
    } else {
      // Update in-memory status immediately so ship-status queries return
      // "error" while async GitHub operations (rescue check, label rollback)
      // are in progress. May be overridden to "done" if rescue succeeds.
      this.shipManager.updateStatus(shipId, "error", "Process exited");

      // Check if the issue was already closed (PR merged) on GitHub.
      // This handles the race where Ship merges the PR but exits before
      // sending the "done" status-transition request.
      const rescued = await this.rescueIfAlreadyDone(ship.repo, ship.issueNumber);
      if (rescued) {
        console.log(
          `[state-sync] Ship #${ship.issueNumber} exited as error but issue is already closed — treating as done`,
        );
        await this.removeWorktreeWithRetry(ship.worktreePath);
        this.shipManager.updateStatus(shipId, "done");

        // Audit depends-on/ labels for rescued (already-closed) issues too
        try {
          await this.auditDependencies(ship.repo, ship.issueNumber);
        } catch (err) {
          console.warn(
            `[state-sync] Failed to audit dependencies for rescued #${ship.issueNumber}:`,
            err,
          );
        }
      } else {
        // Genuinely failed: rollback doing→todo
        await this.rollbackLabel(ship.repo, ship.issueNumber);
      }
    }
  }

  /**
   * Check if an issue is already closed on GitHub (indicating the PR was merged).
   * If closed, clean up the status label. Returns true if rescued.
   */
  private async rescueIfAlreadyDone(
    repo: string,
    issueNumber: number,
  ): Promise<boolean> {
    try {
      const issue = await github.getIssue(repo, issueNumber);
      if (issue.state === "closed") {
        // Issue is closed — remove any leftover status/* label
        const statusLabel = issue.labels.find((l) => l.startsWith("status/"));
        if (statusLabel) {
          try {
            await github.updateLabels(repo, issueNumber, {
              remove: statusLabel,
            });
          } catch (labelErr) {
            console.warn(
              `[state-sync] Failed to remove leftover label "${statusLabel}" from #${issueNumber}:`,
              labelErr,
            );
          }
        }
        return true;
      }
    } catch (err) {
      console.warn(
        `[state-sync] Failed to check issue #${issueNumber} state for rescue:`,
        err,
      );
    }
    return false;
  }

  /**
   * Audit depends-on/ labels after an issue is closed.
   * Finds open issues that have a `depends-on/<closedIssueNumber>` label,
   * removes that label, and transitions `status/blocked` → `status/todo`
   * if all dependencies are now resolved.
   */
  async auditDependencies(
    repo: string,
    closedIssueNumber: number,
  ): Promise<void> {
    const label = `depends-on/${closedIssueNumber}`;

    let dependentIssues: Awaited<ReturnType<typeof github.listIssues>>;
    try {
      dependentIssues = await github.listIssues(repo, label);
    } catch {
      // Label may not exist — that's fine, nothing to audit
      return;
    }

    if (dependentIssues.length === 0) return;

    console.log(
      `[state-sync] Auditing ${dependentIssues.length} issue(s) with label "${label}"`,
    );

    for (const issue of dependentIssues) {
      try {
        // Remove the resolved depends-on/ label
        await github.updateLabels(repo, issue.number, { remove: label });

        // Check if all remaining depends-on/ labels are resolved
        const remainingDeps = parseDependsOnLabels(
          issue.labels.filter((l) => l !== label),
        );

        let allResolved = true;
        if (remainingDeps.length > 0) {
          for (const depNum of remainingDeps) {
            try {
              const dep = await github.getIssue(repo, depNum);
              if (dep.state === "open") {
                allResolved = false;
                break;
              }
            } catch {
              // Can't verify — assume still blocking
              allResolved = false;
              break;
            }
          }
        }

        // If all deps resolved and issue has status/blocked, transition to status/todo
        if (allResolved && issue.labels.includes("status/blocked")) {
          console.log(
            `[state-sync] All dependencies resolved for #${issue.number} — unblocking (status/blocked → status/todo)`,
          );
          await github.updateLabels(repo, issue.number, {
            remove: "status/blocked",
            add: "status/todo",
          });
        }
      } catch (err) {
        console.warn(
          `[state-sync] Failed to audit dependency label for #${issue.number}:`,
          err,
        );
      }
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

    // Restore persisted ships from disk before any cleanup.
    // This ensures getActiveShipIssueNumbers() returns ships that were active
    // when the Engine last shut down, preventing false orphan detection.
    await this.shipManager.restoreFromDisk();

    // Purge completed/error ships with no running process (ghosts from previous runs)
    this.shipManager.purgeOrphanShips();

    const activeShips = this.shipManager.getActiveShipIssueNumbers();

    for (const repo of repos) {
      if (!repo.remote) continue;

      const isActive = (issueNumber: number) =>
        activeShips.some((s) => s.repo === repo.remote && s.issueNumber === issueNumber);

      // 1. Audit active status/* labels: if no active Ship, roll back to "status/todo"
      // Note: "status/blocked" is excluded — it is set manually by Bridge/human
      // to indicate dependency blocks and should persist across Engine restarts.
      // Parallelize all label queries with Promise.allSettled to reduce startup latency.
      const labelResults = await Promise.allSettled(
        [...ACTIVE_STATUS_LABELS].map(async (label) => {
          const labeledIssues = await github.listIssues(repo.remote!, label);
          for (const issue of labeledIssues) {
            if (!isActive(issue.number)) {
              console.warn(
                `[state-sync] Orphan "${label}" label on #${issue.number} — rolling back to "status/todo"`,
              );
              await this.rollbackLabel(repo.remote!, issue.number);
            }
          }
        }),
      );
      for (const result of labelResults) {
        if (result.status === "rejected") {
          console.warn(
            `[state-sync] Failed to audit a status label for ${repo.remote}:`,
            result.reason,
          );
        }
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
          if (!isActive(issueNum)) {
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

    // 3. Mark restored ships (from disk) that have no running process as "error".
    // Their worktrees and labels were protected during reconciliation above.
    // Now mark them so the UI shows they were interrupted by an Engine restart.
    for (const ship of this.shipManager.getAllShips()) {
      if (
        ship.status !== "done" &&
        ship.status !== "error" &&
        !this.shipManager.hasRunningProcess(ship.id)
      ) {
        console.warn(
          `[state-sync] Ship #${ship.issueNumber} (${ship.id.slice(0, 8)}...) has no running process — marking as error`,
        );
        this.shipManager.updateStatus(ship.id, "error", "Engine restarted — no running process");
      }
    }

    console.log("[state-sync] Startup reconciliation complete.");
  }
}
