import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ShipManager } from "./ship-manager.js";
import type { ShipActorManager } from "./ship-actor-manager.js";
import type { EscortManager } from "./escort-manager.js";
import type { StatusManager } from "./status-manager.js";
import type { Phase } from "./types.js";
import * as github from "./github.js";
import * as worktree from "./worktree.js";

const execFileAsync = promisify(execFile);

export interface SortieGuardResult {
  ok: boolean;
  reason?: string;
  /** Non-blocking warnings (e.g., file overlap with active Ships). */
  warnings?: string[];
}

/** The only active status label is "status/sortied". */
export const ACTIVE_STATUS_LABELS = new Set([
  "status/sortied",
]);

/** Process exiting within this window (ms) after start is considered a "rapid death". */
const RAPID_DEATH_THRESHOLD_MS = 120_000;

/** Maximum consecutive rapid deaths before auto-stopping the Ship. */
const MAX_RAPID_DEATHS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class StateSync {
  private shipManager: ShipManager;
  private actorManager: ShipActorManager | null = null;
  private escortManager: EscortManager | null = null;
  private statusManager: StatusManager;

  constructor(shipManager: ShipManager, statusManager: StatusManager) {
    this.shipManager = shipManager;
    this.statusManager = statusManager;
  }

  setActorManager(actorManager: ShipActorManager): void {
    this.actorManager = actorManager;
  }

  setEscortManager(escortManager: EscortManager): void {
    this.escortManager = escortManager;
  }

  async sortieGuard(
    repo: string,
    issueNumber: number,
  ): Promise<SortieGuardResult> {
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

    // 3. Best-effort file overlap detection with active Ships (non-blocking)
    const warnings = await this.detectFileOverlap(repo, issueNumber);

    return { ok: true, warnings: warnings.length > 0 ? warnings : undefined };
  }

  /**
   * Detect potential file overlap between a new issue and active Ships.
   * Uses `gh pr diff --name-only` on active Ships' PRs and compares with
   * the new issue's body for file name hints. Best-effort: errors are swallowed.
   */
  private async detectFileOverlap(
    repo: string,
    issueNumber: number,
  ): Promise<string[]> {
    const warnings: string[] = [];
    try {
      // Get active ships in the same repo (excluding done/paused/abandoned)
      const activeShips = this.shipManager.getAllShips().filter(
        (s) =>
          s.repo === repo &&
          s.phase !== "done" &&
          s.phase !== "paused" &&
          s.phase !== "abandoned" &&
          s.issueNumber !== issueNumber,
      );
      if (activeShips.length === 0) return [];

      // Collect changed files from active Ships' PRs
      const shipFiles = new Map<number, string[]>(); // issueNumber -> files
      await Promise.all(
        activeShips.map(async (ship) => {
          try {
            const { stdout } = await execFileAsync("gh", [
              "pr", "diff",
              "--name-only",
              "--repo", repo,
              ship.branchName,
            ]);
            const files = stdout.trim().split("\n").filter(Boolean);
            if (files.length > 0) {
              shipFiles.set(ship.issueNumber, files);
            }
          } catch {
            // PR may not exist yet — skip
          }
        }),
      );
      if (shipFiles.size === 0) return [];

      // Extract file name hints from the new issue body (best-effort)
      const issueBody = await this.getIssueBody(repo, issueNumber);
      if (!issueBody) return [];

      // Match code-like references: backtick-wrapped file paths or .ts/.tsx/.js/.jsx/.md extensions
      const filePattern = /`([^`]*\.[a-z]{1,4})`|(\b[\w/.-]+\.(?:ts|tsx|js|jsx|md|json)\b)/g;
      const mentionedFiles = new Set<string>();
      let match;
      while ((match = filePattern.exec(issueBody)) !== null) {
        const file = match[1] || match[2];
        if (file) {
          // Extract just the filename (last segment) for fuzzy matching
          const basename = file.split("/").pop()!;
          mentionedFiles.add(basename);
          mentionedFiles.add(file);
        }
      }
      if (mentionedFiles.size === 0) return [];

      // Compare: find overlapping files
      for (const [shipIssue, files] of shipFiles) {
        const overlapping = files.filter((f) => {
          const basename = f.split("/").pop()!;
          return mentionedFiles.has(basename) || mentionedFiles.has(f);
        });
        if (overlapping.length > 0) {
          const fileList = overlapping.slice(0, 5).join(", ");
          const suffix = overlapping.length > 5 ? ` (+${overlapping.length - 5} more)` : "";
          warnings.push(
            `Potential file overlap with Ship #${shipIssue}: ${fileList}${suffix}`,
          );
        }
      }
    } catch (err) {
      // Best-effort: don't block sortie on detection failure
      console.warn(
        `[state-sync] File overlap detection failed for #${issueNumber}:`,
        err,
      );
    }
    return warnings;
  }

  private async getIssueBody(
    repo: string,
    issueNumber: number,
  ): Promise<string | null> {
    try {
      const issue = await github.getIssue(repo, issueNumber);
      return issue.body || null;
    } catch {
      return null;
    }
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

    // Clear compacting flag — process is gone, no more compact events
    this.shipManager.setIsCompacting(shipId, false);

    if (succeeded) {
      // Paused/abandoned ships: skip done transition, worktree removal, and issue closure.
      // The worktree is preserved for re-sortie. Label rollback is handled by
      // the ship:pause handler in ws-server.
      if (ship.phase === "paused" || ship.phase === "abandoned") {
        return;
      }

      // Transition to done via XState (sole authority for phase transitions)
      this.actorManager?.send(shipId, { type: "COMPLETE" });
      this.shipManager.updatePhase(shipId, "done");

      // Clean up Escort: kill process + mark DB record as done
      this.escortManager?.cleanupForDoneShip(shipId);

      // Persist chat logs to DB before worktree deletion
      await this.shipManager.persistChatLogs(shipId);

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

      // --- Rapid death detection ---
      // If the process exited shortly after starting, it may be stuck in a
      // resume → instant death loop (Issue #618). Track consecutive rapid deaths
      // and auto-stop the Ship after MAX_RAPID_DEATHS.
      const lastStartedAt = this.shipManager.getLastStartedAt(shipId);
      const isRapidDeath = lastStartedAt !== null
        && (Date.now() - lastStartedAt) < RAPID_DEATH_THRESHOLD_MS;

      if (isRapidDeath) {
        const count = this.shipManager.incrementRapidDeathCount(shipId);
        console.warn(
          `[state-sync] Ship #${ship.issueNumber} (${shipId.slice(0, 8)}...) rapid death detected ` +
          `(${count}/${MAX_RAPID_DEATHS}, died ${Math.round((Date.now() - lastStartedAt!) / 1000)}s after start)`,
        );
        if (count >= MAX_RAPID_DEATHS) {
          console.error(
            `[state-sync] Ship #${ship.issueNumber} (${shipId.slice(0, 8)}...) hit rapid death limit ` +
            `(${MAX_RAPID_DEATHS} consecutive rapid deaths) — auto-stopping to prevent infinite loop`,
          );
          this.actorManager?.send(shipId, { type: "PAUSE" });
          this.actorManager?.send(shipId, { type: "RAPID_DEATH_LIMIT" });
          this.shipManager.updatePhase(shipId, "paused", `Auto-paused: ${MAX_RAPID_DEATHS} consecutive rapid deaths`);
          return;
        }
      } else {
        // Not a rapid death — reset the counter
        this.shipManager.resetRapidDeathCount(shipId);
      }

      // Notify the status change handler so Bridge gets notified.
      this.shipManager.notifyProcessDead(shipId);

      // Persist chat logs on failure too (worktree may be cleaned up later)
      await this.shipManager.persistChatLogs(shipId);

      // --- PR existence fallback ---
      // If the Ship is in "coding" phase and a PR exists for the branch,
      // the Ship likely created a PR but died before calling the phase-transition API.
      // Auto-transition to coding-gate so the Escort can review the PR.
      // Guard: skip if Escort has already failed in this gate (escortFailCount > 0),
      // to prevent coding ↔ coding-gate infinite loop when Escort keeps crashing.
      if (ship.phase === "coding") {
        const context = this.actorManager?.getContext(shipId);
        if (context && context.escortFailCount > 0) {
          console.warn(
            `[state-sync] PR fallback suppressed for Ship #${ship.issueNumber} (${shipId.slice(0, 8)}...): ` +
            `escortFailCount=${context.escortFailCount} — Escort has been failing in this gate`,
          );
        } else {
          const prFallbackApplied = await this.rescueWithPRFallback(shipId, ship.repo, ship.branchName, ship.issueNumber);
          if (prFallbackApplied) return;
        }
      }

      // --- Merging-phase rescue (#761, #830) ---
      // Only rescue Ships in "merging" phase — they are close to completion
      // and may have finished the merge but died before declaring done.
      // Ships in earlier phases (plan, coding, qa) must NOT be rescued to done,
      // even if the issue happens to be closed externally (#830).
      if (ship.phase === "merging") {
        // Check if the issue was already closed (PR merged) on GitHub.
        const rescued = await this.rescueIfAlreadyDone(ship.repo, ship.issueNumber, ship.phase);
        if (rescued) {
          console.log(
            `[state-sync] Ship #${ship.issueNumber} died in merging but issue is already closed — treating as done`,
          );
          await this.completeDoneCleanup(shipId, ship);
          return;
        }

        // Check if the PR was actually merged (issue may still be open if
        // PR body lacked "Closes #NNN").
        if (ship.branchName) {
          const mergedPR = await this.rescueIfPRMerged(ship.repo, ship.branchName, ship.issueNumber);
          if (mergedPR) {
            console.log(
              `[state-sync] Ship #${ship.issueNumber} died in merging but PR #${mergedPR.number} is merged — treating as done`,
            );
            await this.completeDoneCleanup(shipId, ship);
            return;
          }
        }
      }

      // Genuinely failed: rollback sortied→ready (removes status/sortied label)
      await this.rollbackLabel(ship.repo, ship.issueNumber);
    }
  }

  /**
   * PR existence fallback: if a Ship died in "coding" phase but a PR
   * already exists for the branch, auto-transition to coding-gate
   * so the Escort can review the PR.
   * Returns true if the fallback was applied.
   */
  private async rescueWithPRFallback(
    shipId: string,
    repo: string,
    branchName: string,
    issueNumber: number,
  ): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync("gh", [
        "pr", "list",
        "--head", branchName,
        "--repo", repo,
        "--state", "open",
        "--json", "number,url",
        "--jq", ".[0]",
      ]);
      const trimmed = stdout.trim();
      if (!trimmed) return false;

      const pr = JSON.parse(trimmed) as { number: number; url: string };
      console.log(
        `[state-sync] Ship #${issueNumber} (${shipId.slice(0, 8)}...) died in coding phase ` +
        `but PR #${pr.number} exists — auto-transitioning to coding-gate`,
      );

      // Transition: coding → coding-gate via XState GATE_ENTER event
      this.actorManager?.send(shipId, { type: "GATE_ENTER" });
      this.shipManager.updatePhase(shipId, "coding-gate", `PR fallback: PR #${pr.number} found`);

      // Store PR URL so the Escort can find it
      this.shipManager.setPrUrl(shipId, pr.url);

      return true;
    } catch {
      // gh CLI failed or no PR found — not a fallback scenario
      return false;
    }
  }

  /**
   * Shared cleanup for done transition: worktree removal, issue closure,
   * Escort cleanup, and dependency audit. Used by both the success path
   * and rescue paths to avoid duplication.
   */
  private async completeDoneCleanup(
    shipId: string,
    ship: { repo: string; issueNumber: number; worktreePath: string },
  ): Promise<void> {
    // Transition to done via XState (sole authority for phase transitions).
    // Verify XState actually transitioned before proceeding with cleanup (#830).
    const result = this.actorManager?.requestTransition(shipId, {
      type: "NOTHING_TO_DO",
      reason: "Rescued: PR merged or issue closed",
    });
    if (result && !result.success) {
      console.warn(
        `[state-sync] completeDoneCleanup rejected by XState for Ship #${ship.issueNumber} ` +
        `(${shipId.slice(0, 8)}...): current phase is ${result.currentPhase ?? "unknown"} — aborting rescue`,
      );
      return;
    }
    this.shipManager.updatePhase(shipId, "done");
    await this.removeWorktreeWithRetry(ship.worktreePath);

    // Clean up Escort: kill process + mark DB record as done
    this.escortManager?.cleanupForDoneShip(shipId);

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
        `[state-sync] Failed to audit dependencies for rescued #${ship.issueNumber}:`,
        err,
      );
    }
  }

  /**
   * Check if a merged PR exists for the Ship's branch (#761).
   * Used when Ship dies in merging phase — the PR may have been merged
   * but the Ship died before calling the phase-transition API.
   */
  private async rescueIfPRMerged(
    repo: string,
    branchName: string,
    issueNumber: number,
  ): Promise<{ number: number; url: string } | null> {
    try {
      return await github.getMergedPRForBranch(repo, branchName);
    } catch (err) {
      console.warn(
        `[state-sync] Failed to check merged PR for #${issueNumber} (branch: ${branchName}):`,
        err,
      );
      return null;
    }
  }

  /**
   * Check if the issue was closed on GitHub (rescue to done).
   * Defense-in-depth (#839): accepts currentPhase and aborts if not "merging".
   * The caller already checks `ship.phase === "merging"`, but this guard
   * prevents future call-site additions from skipping the check.
   */
  private async rescueIfAlreadyDone(
    repo: string,
    issueNumber: number,
    currentPhase?: string,
  ): Promise<boolean> {
    if (currentPhase !== undefined && currentPhase !== "merging") {
      console.warn(
        `[state-sync] rescueIfAlreadyDone blocked: phase is "${currentPhase}" (expected "merging") for #${issueNumber}`,
      );
      return false;
    }
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
        // Remove the resolved depends-on label
        await github.updateLabels(repo, issue.number, { remove: label });
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
                `[state-sync] Orphan "${label}" label on #${issue.number} — removing`,
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
      const legacyLabels = ["status/ready", "status/mooring", "status/todo", "status/blocked", "status/planning", "status/implementing", "status/acceptance-test", "status/merging"];
      for (const label of legacyLabels) {
        try {
          const labeledIssues = await github.listIssues(repo.remote!, label);
          for (const issue of labeledIssues) {
            console.warn(
              `[state-sync] Legacy label "${label}" on #${issue.number} — removing`,
            );
            try {
              await github.updateLabels(repo.remote!, issue.number, { remove: label });
            } catch (removeErr) {
              console.warn(
                `[state-sync] Failed to remove legacy label "${label}" from #${issue.number}:`,
                removeErr,
              );
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

    // 3. Validate XState/DB phase consistency after restoration (#689).
    // Auto-repair mismatches by reconciling XState to DB phase (#694).
    for (const ship of this.shipManager.getAllShips()) {
      if (ship.phase !== "done") {
        if (!this.actorManager?.assertPhaseConsistency(ship.id, ship.phase as Phase)) {
          this.actorManager?.reconcilePhase(ship.id, ship.phase as Phase);
        }
      }
    }

    // 4. Restored ships with no running process remain in their phase.
    // The UI will show them as "process dead" based on the derived state.
    // Notify for each so Bridge gets the process-dead notification.
    for (const ship of this.shipManager.getAllShips()) {
      if (
        ship.phase !== "done" &&
        ship.phase !== "paused" &&
        ship.phase !== "abandoned" &&
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
