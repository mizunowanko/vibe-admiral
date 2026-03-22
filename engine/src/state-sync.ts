import type { ShipManager } from "./ship-manager.js";
import type { StatusManager } from "./status-manager.js";
import * as github from "./github.js";
import * as worktree from "./worktree.js";
import { parseDependsOnLabels } from "./github.js";

/** The only active status label is "status/sortied". */
export const ACTIVE_STATUS_LABELS = new Set([
  "status/sortied",
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

  async sortieGuard(
    repo: string,
    issueNumber: number,
  ): Promise<{ ok: boolean; reason?: string }> {
    // 1. Check if a Ship is already running for this issue
    const existing = this.shipManager.getShipByIssue(repo, issueNumber);
    if (existing) {
      return {
        ok: false,
        reason: `Issue #${issueNumber} already has an active Ship (${existing.id.slice(0, 8)}..., phase: ${existing.phase})`,
      };
    }

    // 2. Check issue state: must be open and in "ready" status
    try {
      const status = await this.statusManager.getStatus(repo, issueNumber);
      if (status === "done") {
        return {
          ok: false,
          reason: `Issue #${issueNumber} is already closed`,
        };
      }
      if (status === "sortied") {
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

  async rollbackLabel(
    repo: string,
    issueNumber: number,
    maxRetries = 3,
  ): Promise<void> {
    await this.statusManager.rollback(repo, issueNumber, maxRetries);
  }

  async removeWorktreeWithRetry(
    worktreePath: string,
    maxRetries = 3,
    repoRoot?: string,
  ): Promise<void> {
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
   * With the new phase model, there is no "error" phase.
   * Process death is a derived state (phase ≠ done && process dead).
   */
  async onProcessExit(shipId: string, succeeded: boolean): Promise<void> {
    const ship = this.shipManager.getShip(shipId);
    if (!ship) return;

    // Escort-Ships: skip worktree cleanup, label rollback, and issue closure.
    // Their lifecycle is tied to the parent Ship, not the issue.
    if (ship.kind === "escort") {
      this.shipManager.setIsCompacting(shipId, false);
      return;
    }

    // Clear compacting flag — process is gone, no more compact events
    this.shipManager.setIsCompacting(shipId, false);

    if (succeeded) {
      // Stopped ships: skip done transition, worktree removal, and issue closure.
      // The worktree is preserved for re-sortie. Label rollback is handled by
      // the ship:stop handler in ws-server.
      if (ship.phase === "stopped") {
        return;
      }

      this.shipManager.updatePhase(shipId, "done");

      // Successful completion: remove worktree, mark done (label + close issue)
      await this.removeWorktreeWithRetry(ship.worktreePath);

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

      try {
        await this.auditDependencies(ship.repo, ship.issueNumber);
      } catch (err) {
        console.warn(
          `[state-sync] Failed to audit dependencies for #${ship.issueNumber}:`,
          err,
        );
      }
    } else {
      // Process died without declaring done.
      // With the new model, we do NOT set an "error" phase — the ship stays
      // in its current phase. The UI derives "process dead" from phase ≠ done && no process.
      // Notify the status change handler so Bridge gets notified.
      this.shipManager.notifyProcessDead(shipId);

      // Check if the issue was already closed (PR merged) on GitHub.
      const rescued = await this.rescueIfAlreadyDone(ship.repo, ship.issueNumber);
      if (rescued) {
        console.log(
          `[state-sync] Ship #${ship.issueNumber} exited but issue is already closed — treating as done`,
        );
        await this.removeWorktreeWithRetry(ship.worktreePath);
        this.shipManager.updatePhase(shipId, "done");

        try {
          await this.auditDependencies(ship.repo, ship.issueNumber);
        } catch (err) {
          console.warn(
            `[state-sync] Failed to audit dependencies for rescued #${ship.issueNumber}:`,
            err,
          );
        }
      } else {
        // Genuinely failed: rollback sortied→ready
        await this.rollbackLabel(ship.repo, ship.issueNumber);
      }
    }
  }

  private async rescueIfAlreadyDone(
    repo: string,
    issueNumber: number,
  ): Promise<boolean> {
    try {
      const issue = await github.getIssue(repo, issueNumber);
      if (issue.state === "closed") {
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

  async auditDependencies(
    repo: string,
    closedIssueNumber: number,
  ): Promise<void> {
    const label = `depends-on/${closedIssueNumber}`;

    let dependentIssues: Awaited<ReturnType<typeof github.listIssues>>;
    try {
      dependentIssues = await github.listIssues(repo, label);
    } catch {
      return;
    }

    if (dependentIssues.length === 0) return;

    console.log(
      `[state-sync] Auditing ${dependentIssues.length} issue(s) with label "${label}"`,
    );

    for (const issue of dependentIssues) {
      try {
        await github.updateLabels(repo, issue.number, { remove: label });

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
              allResolved = false;
              break;
            }
          }
        }

        if (allResolved && issue.labels.includes("status/mooring")) {
          console.log(
            `[state-sync] All dependencies resolved for #${issue.number} — unblocking (status/mooring → status/ready)`,
          );
          await github.updateLabels(repo, issue.number, {
            remove: "status/mooring",
            add: "status/ready",
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

  async reconcileOnStartup(
    repos: Array<{ remote?: string; localPath: string }>,
  ): Promise<void> {
    console.log("[state-sync] Running startup reconciliation...");

    await this.shipManager.restoreFromDisk();
    this.shipManager.purgeOrphanShips();

    const activeShips = this.shipManager.getActiveShipIssueNumbers();

    for (const repo of repos) {
      if (!repo.remote) continue;

      const isActive = (issueNumber: number) =>
        activeShips.some((s) => s.repo === repo.remote && s.issueNumber === issueNumber);

      // 1. Audit active status/* labels
      const labelResults = await Promise.allSettled(
        [...ACTIVE_STATUS_LABELS].map(async (label) => {
          const labeledIssues = await github.listIssues(repo.remote!, label);
          for (const issue of labeledIssues) {
            if (!isActive(issue.number)) {
              console.warn(
                `[state-sync] Orphan "${label}" label on #${issue.number} — rolling back to "status/ready"`,
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

      // Also clean up legacy labels from pre-refactoring
      const legacyLabels = ["status/todo", "status/blocked", "status/planning", "status/implementing", "status/acceptance-test", "status/merging"];
      for (const label of legacyLabels) {
        try {
          const labeledIssues = await github.listIssues(repo.remote!, label);
          for (const issue of labeledIssues) {
            if (!isActive(issue.number)) {
              console.warn(
                `[state-sync] Legacy label "${label}" on #${issue.number} — rolling back to "status/ready"`,
              );
              await this.rollbackLabel(repo.remote!, issue.number);
            }
          }
        } catch {
          // Label may not exist
        }
      }

      // 2. Clean up orphan feature worktrees
      try {
        const repoRoot = await worktree.getRepoRoot(repo.localPath);
        const featureWorktrees = await worktree.listFeatureWorktrees(repoRoot);
        for (const wt of featureWorktrees) {
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

    // 3. Restored ships with no running process remain in their phase.
    // The UI will show them as "process dead" based on the derived state.
    // Notify for each so Bridge gets the process-dead notification.
    for (const ship of this.shipManager.getAllShips()) {
      if (
        ship.phase !== "done" &&
        ship.phase !== "stopped" &&
        !this.shipManager.hasRunningProcess(ship.id)
      ) {
        console.warn(
          `[state-sync] Ship #${ship.issueNumber} (${ship.id.slice(0, 8)}...) has no running process — notifying as process dead`,
        );
        this.shipManager.notifyProcessDead(ship.id);
      }
    }

    console.log("[state-sync] Startup reconciliation complete.");
  }
}
