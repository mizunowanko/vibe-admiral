import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ProcessManager } from "./process-manager.js";
import type { StatusManager } from "./status-manager.js";
import type { FleetDatabase } from "./db.js";
import * as github from "./github.js";
import * as worktree from "./worktree.js";
import type { ShipProcess, Phase, FleetSkillSources, GatePhase, GateType, GateCheckState, PRReviewStatus } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Runtime-only state for a Ship. Kept in-memory only — not persisted to DB.
 * This covers transient process state that changes rapidly or is only
 * meaningful while the Engine process is alive.
 */
interface ShipRuntime {
  isCompacting: boolean;
  lastOutputAt: number | null;
  processDead?: boolean;
  gateCheck: GateCheckState | null;
  prReviewStatus: PRReviewStatus | null;
  retryCount: number;
}

export class ShipManager {
  /**
   * In-memory Map: stores only runtime/transient state per Ship.
   * Ship display data (phase, issueNumber, worktreePath, etc.) is read from DB.
   */
  private runtime = new Map<string, ShipRuntime>();
  private processManager: ProcessManager;
  private statusManager: StatusManager;
  private fleetDb: FleetDatabase | null = null;
  private onPhaseChange:
    | ((id: string, phase: Phase, detail?: string) => void)
    | null = null;

  constructor(
    processManager: ProcessManager,
    statusManager: StatusManager,
  ) {
    this.processManager = processManager;
    this.statusManager = statusManager;
  }

  setDatabase(db: FleetDatabase): void {
    this.fleetDb = db;
  }

  /** Get the fleet database path (used by EscortManager for Escort env vars). */
  getDbPath(): string | undefined {
    return this.fleetDb?.path;
  }

  setPhaseChangeHandler(
    handler: (id: string, phase: Phase, detail?: string) => void,
  ): void {
    this.onPhaseChange = handler;
  }

  async sortie(
    fleetId: string,
    repo: string,
    issueNumber: number,
    localPath: string,
    skillSources?: FleetSkillSources,
    extraPrompt?: string,
    skill?: string,
  ): Promise<ShipProcess> {
    // Clean up all completed ships (done) on every new sortie
    if (this.fleetDb) {
      const allShips = this.fleetDb.getAllShips();
      for (const ship of allShips) {
        if (ship.phase === "done" || ship.phase === "stopped") {
          this.runtime.delete(ship.id);
          this.fleetDb.deleteShip(ship.id);
        }
      }
    }

    const shipId = randomUUID();

    // 1. Get issue info (used later for title, slug, etc.)
    const issue = await github.getIssue(repo, issueNumber);

    // 2. Update issue status: todo → doing (via StatusManager)
    await this.statusManager.markSortied(repo, issueNumber);

    // 3. Create worktree
    const repoRoot = await worktree.getRepoRoot(localPath);
    const defaultBranch = await github.getDefaultBranch(repo);
    const slug = worktree.toKebabCase(issue.title);
    const branchName = `feature/${issueNumber}-${slug}`;
    const worktreePath = `${repoRoot}/.worktrees/feature/${issueNumber}-${slug}`;

    await worktree.create(worktreePath, branchName, defaultBranch);

    // 4. Symlink settings
    await worktree.symlinkSettings(repoRoot, worktreePath);

    // 5. Copy /implement skill to worktree
    await this.deploySkills(repoRoot, worktreePath, skillSources);

    // 6. Remove stale workflow-state.json from previous sortie
    await unlink(join(worktreePath, ".claude", "workflow-state.json")).catch(() => {});

    // 7. npm install if web project
    if (await worktree.isWebProject(worktreePath)) {
      await execFileAsync("npm", ["install"], { cwd: worktreePath });
    }

    // 8. Detect existing PR for branch reuse (preserves review history)
    let existingPrUrl: string | null = null;
    let existingPrReviewStatus: PRReviewStatus | null = null;
    try {
      const { stdout } = await execFileAsync("gh", [
        "pr", "list",
        "--head", branchName,
        "--repo", repo,
        "--json", "number,url",
        "--jq", ".[0]",
      ]);
      const trimmed = stdout.trim();
      if (trimmed) {
        const pr = JSON.parse(trimmed) as { number: number; url: string };
        existingPrUrl = pr.url;
        existingPrReviewStatus = "pending";
        console.log(`[ship-manager] Existing PR detected for #${issueNumber}: ${pr.url}`);
      }
    } catch {
      // No existing PR or gh failed — continue without it
    }

    const ship: ShipProcess = {
      id: shipId,
      fleetId,
      repo,
      issueNumber,
      issueTitle: issue.title,
      phase: "planning",
      isCompacting: false,
      branchName,
      worktreePath,
      sessionId: null,
      prUrl: existingPrUrl,
      prReviewStatus: existingPrReviewStatus,
      gateCheck: null,
      qaRequired: true,
      retryCount: 0,
      createdAt: new Date().toISOString(),
      lastOutputAt: null,
    };

    // Persist to DB first — DB record is a precondition for process spawn.
    // If INSERT fails, we must NOT launch the CLI process (prevents orphans).
    try {
      this.persistToDb(ship);
    } catch (err) {
      console.error(`[ship-manager] DB INSERT failed for ship ${shipId} (issue #${issueNumber}):`, err);
      // Roll back: remove worktree created in step 3
      await worktree.remove(worktreePath).catch(() => {});
      throw new Error(`Failed to persist ship to DB for issue #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Store runtime state in memory
    this.runtime.set(shipId, {
      isCompacting: false,
      lastOutputAt: null,
      processDead: false,
      gateCheck: null,
      prReviewStatus: existingPrReviewStatus,
      retryCount: 0,
    });

    // 9. Build extra context for Ship
    // Embed issue info in the prompt so Ship doesn't need to call `gh issue view`
    const issueContext = [
      `[Issue Context] Issue #${issue.number}: ${issue.title}`,
      `Labels: ${issue.labels.join(", ") || "none"}`,
      `Body:\n${issue.body}`,
    ].join("\n");
    const prContext = existingPrUrl
      ? `\n\n[Prior Work Context] An existing PR was found for this branch: ${existingPrUrl}. The branch contains previous commits from a prior sortie. Check for existing work before starting from scratch. Run \`gh pr view --json number,url,body,reviews,comments\` to review the PR history.`
      : "";
    const fullExtraPrompt = [issueContext, extraPrompt, prContext]
      .filter(Boolean)
      .join("\n\n") || undefined;

    // 10. Launch Claude CLI process with Engine API access
    const shipEnv: Record<string, string> = {
      VIBE_ADMIRAL_MAIN_REPO: repo,
      VIBE_ADMIRAL_SHIP_ID: shipId,
    };
    this.processManager.sortie(shipId, worktreePath, issueNumber, fullExtraPrompt, skill, shipEnv);

    this.updatePhase(shipId, "planning");
    return ship;
  }

  stopShip(shipId: string): boolean {
    const killed = this.processManager.kill(shipId);
    if (killed) {
      const rt = this.runtime.get(shipId);
      if (rt) rt.isCompacting = false;
      this.updatePhase(shipId, "stopped", "Manually stopped");
    }
    return killed;
  }

  /**
   * Get a Ship by ID. Reads persistent data from DB and merges runtime state.
   * Returns a mutable ShipProcess with runtime data overlaid.
   */
  getShip(shipId: string): ShipProcess | undefined {
    const dbShip = this.fleetDb?.getShipById(shipId);
    if (!dbShip) return undefined;
    return this.mergeRuntime(dbShip);
  }

  /**
   * Resolve a Ship by: exact UUID → prefix match → issueNumber fallback.
   * Returns undefined if no match or if a prefix matches multiple ships.
   */
  resolveShip(shipId: string, issueNumber?: number): ShipProcess | undefined {
    // 1. Exact match
    const exact = this.getShip(shipId);
    if (exact) return exact;

    // 2. Prefix match (only if shipId is shorter than a full UUID)
    if (shipId.length < 36 && this.fleetDb) {
      const allShips = this.fleetDb.getAllShips();
      const prefixMatches = allShips.filter((s) => s.id.startsWith(shipId));
      if (prefixMatches.length === 1) {
        return this.mergeRuntime(prefixMatches[0]!);
      }
    }

    // 3. issueNumber fallback (active ships only)
    if (issueNumber !== undefined && this.fleetDb) {
      const activeShips = this.fleetDb.getActiveShips();
      const match = activeShips.find((s) => s.issueNumber === issueNumber);
      if (match) return this.mergeRuntime(match);
    }

    return undefined;
  }

  getShipsByFleet(fleetId: string): ShipProcess[] {
    if (!this.fleetDb) return [];
    return this.fleetDb.getShipsByFleet(fleetId).map((s) => this.mergeRuntime(s));
  }

  getAllShips(): ShipProcess[] {
    if (!this.fleetDb) return [];
    return this.fleetDb.getAllShips().map((s) => this.mergeRuntime(s));
  }

  getShipByIssue(repo: string, issueNumber: number): ShipProcess | undefined {
    if (!this.fleetDb) return undefined;
    const dbShip = this.fleetDb.getShipByIssue(repo, issueNumber);
    return dbShip ? this.mergeRuntime(dbShip) : undefined;
  }

  getActiveShipIssueNumbers(): Array<{ repo: string; issueNumber: number }> {
    if (!this.fleetDb) return [];
    return this.fleetDb.getActiveShipIssueNumbers();
  }

  hasRunningProcess(shipId: string): boolean {
    return this.processManager.isRunning(shipId);
  }

  /**
   * Notify that a Ship's process has died without reaching "done".
   * Sets processDead flag and triggers phase change notification so
   * Bridge/frontend can display the derived "process dead" state.
   */
  notifyProcessDead(shipId: string): void {
    const rt = this.ensureRuntime(shipId);
    if (!rt) return;
    rt.processDead = true;
    // Trigger notification without changing the phase — the UI derives
    // "process dead" from phase ≠ done && processDead flag.
    const ship = this.getShip(shipId);
    if (ship) {
      this.onPhaseChange?.(shipId, ship.phase, "Process dead");
    }
  }

  updatePhase(id: string, phase: Phase, detail?: string): void {
    const dbShip = this.fleetDb?.getShipById(id);
    if (dbShip) {
      const previousPhase = dbShip.phase;
      // Update DB
      if (phase === "done") {
        this.fleetDb?.updateShipPhase(id, phase, Date.now());
      } else {
        this.fleetDb?.updateShipPhase(id, phase);
      }
      // Record phase transition
      if (previousPhase !== phase) {
        try {
          this.fleetDb?.recordPhaseTransition(id, previousPhase, phase, "engine");
        } catch (err) {
          console.warn("[ship-manager] Failed to record phase transition:", err);
        }
      }
      // Notify frontend
      this.onPhaseChange?.(id, phase, detail);
    }
  }

  /**
   * Sync phase from DB and notify frontend.
   * Called by the REST API after it has already updated the DB via transitionPhase().
   * Unlike updatePhase(), this does NOT write to DB — it only reads and notifies.
   */
  syncPhaseFromDb(id: string): void {
    const dbShip = this.fleetDb?.getShipById(id);
    if (dbShip) {
      this.onPhaseChange?.(id, dbShip.phase as Phase);
    }
  }

  /** Update a Ship's session ID (runtime + DB). */
  setSessionId(id: string, sessionId: string): void {
    this.fleetDb?.updateShipSessionId(id, sessionId);
  }

  /** Update a Ship's PR URL (DB). */
  setPrUrl(id: string, prUrl: string): void {
    if (!this.fleetDb) return;
    const dbShip = this.fleetDb.getShipById(id);
    if (dbShip) {
      dbShip.prUrl = prUrl;
      this.fleetDb.upsertShip(dbShip);
    }
  }

  /** Update a Ship's lastOutputAt timestamp (runtime only). */
  setLastOutputAt(id: string, timestamp: number): void {
    const rt = this.ensureRuntime(id);
    if (rt) rt.lastOutputAt = timestamp;
  }

  /** Update a Ship's isCompacting state (runtime only). */
  setIsCompacting(id: string, isCompacting: boolean): void {
    const rt = this.ensureRuntime(id);
    if (rt) rt.isCompacting = isCompacting;
  }

  setQaRequired(id: string, qaRequired: boolean): void {
    if (!this.fleetDb) return;
    const dbShip = this.fleetDb.getShipById(id);
    if (dbShip) {
      dbShip.qaRequired = qaRequired;
      this.fleetDb.upsertShip(dbShip);
    }
  }

  respondToPRReview(
    shipId: string,
    result: { verdict: "approve" | "request-changes"; comments?: string },
  ): void {
    const rt = this.ensureRuntime(shipId);
    if (rt) {
      rt.prReviewStatus =
        result.verdict === "approve" ? "approved" : "changes-requested";
    }
  }

  setGateCheck(
    shipId: string,
    gatePhase: GatePhase,
    gateType: GateType,
  ): void {
    const rt = this.ensureRuntime(shipId);
    if (rt) {
      rt.gateCheck = {
        gatePhase,
        gateType,
        status: "pending",
        requestedAt: new Date().toISOString(),
      };
    }
  }

  clearGateCheck(shipId: string): void {
    const rt = this.ensureRuntime(shipId);
    if (rt) rt.gateCheck = null;
  }

  private async deploySkills(
    repoRoot: string,
    worktreePath: string,
    skillSources?: FleetSkillSources,
  ): Promise<void> {
    // Copy /implement orchestrator + sub-skills from the main repo's skills/
    // The orchestrator is essential for Ship operation — failure is fatal.
    const implementSrc = skillSources?.implement
      ? join(skillSources.implement, "SKILL.md")
      : join(repoRoot, "skills", "implement", "SKILL.md");
    const implementDestDir = join(worktreePath, ".claude", "skills", "implement");
    await mkdir(implementDestDir, { recursive: true });
    await copyFile(implementSrc, join(implementDestDir, "SKILL.md"));

    // Deploy Ship sub-skills and shared skills from repo's skills/ (non-fatal individually)
    const repoSkills = [
      // Ship sub-skills
      "implement-setup",
      "implement-plan",
      "implement-code",
      "implement-review",
      "implement-merge",
      // Gate skills (deployed to worktree; Engine launches Escort processes that use these)
      "gate-plan-review",
      "gate-code-review",
      // Shared skills (Bridge/Ship common)
      "admiral-protocol",
      "read-issue",
      // Other repo skills
      "adr",
    ];
    for (const skillName of repoSkills) {
      const src = join(repoRoot, "skills", skillName, "SKILL.md");
      const destDir = join(worktreePath, ".claude", "skills", skillName);
      try {
        await mkdir(destDir, { recursive: true });
        await copyFile(src, join(destDir, "SKILL.md"));
      } catch {
        console.warn(`[ship-manager] Failed to deploy /${skillName} skill`);
      }
    }

    // Copy dev-shared skills if devSharedDir is configured
    const devSharedDir = skillSources?.devSharedDir;
    if (!devSharedDir) return;

    const devSharedSkills = ["review-pr", "second-opinion", "test", "refactor"];
    for (const skillName of devSharedSkills) {
      const src = join(devSharedDir, skillName, "SKILL.md");
      const destDir = join(worktreePath, ".claude", "skills", skillName);
      try {
        await mkdir(destDir, { recursive: true });
        await copyFile(src, join(destDir, "SKILL.md"));
      } catch {
        console.warn(`[ship-manager] Failed to deploy /${skillName} skill from dev-shared`);
      }
    }
  }

  /**
   * Remove completed Ships that have no running process.
   * Called during startup reconciliation to clear ghosts from previous runs.
   */
  purgeOrphanShips(): number {
    if (!this.fleetDb) return 0;
    let purged = 0;
    const allShips = this.fleetDb.getAllShips();
    for (const ship of allShips) {
      if (
        ship.phase === "done" &&
        !this.processManager.isRunning(ship.id)
      ) {
        this.runtime.delete(ship.id);
        this.fleetDb.deleteShip(ship.id);
        purged++;
      }
    }
    if (purged > 0) {
      console.log(`[ship-manager] Purged ${purged} orphan ship(s)`);
    }
    return purged;
  }

  /**
   * Retry a dead Ship. If the Ship has a sessionId, resume the session.
   * Otherwise, re-sortie from scratch.
   * Retryable condition: phase !== "done" && process is dead.
   * Returns the resumed/re-launched ShipProcess, or null if not retryable.
   */
  retryShip(
    shipId: string,
    extraPrompt?: string,
    skill?: string,
  ): ShipProcess | null {
    const ship = this.getShip(shipId);
    if (!ship) return null;

    // Only retry if the process is dead and phase is not terminal
    if (ship.phase === "done" || this.processManager.isRunning(shipId)) {
      return null;
    }

    const rt = this.ensureRuntime(shipId);
    if (rt) {
      rt.retryCount++;
      rt.processDead = false;
    }

    // Build extra env vars for the Ship process
    const shipEnv: Record<string, string> = {
      VIBE_ADMIRAL_MAIN_REPO: ship.repo,
      VIBE_ADMIRAL_SHIP_ID: shipId,
    };

    if (ship.sessionId) {
      // Resume existing session
      this.processManager.resumeSession(
        shipId,
        ship.sessionId,
        "The previous session was interrupted. Continue from where you left off.",
        ship.worktreePath,
        shipEnv,
      );
      this.updatePhase(shipId, "implementing", "Resumed from session");
    } else {
      // No session to resume — re-sortie
      this.processManager.sortie(
        shipId,
        ship.worktreePath,
        ship.issueNumber,
        extraPrompt,
        skill,
        shipEnv,
      );
      this.updatePhase(shipId, "planning", "Re-sortied");
    }

    return this.getShip(shipId) ?? null;
  }

  stopAll(): void {
    if (this.fleetDb) {
      const allShips = this.fleetDb.getAllShips();
      for (const ship of allShips) {
        this.processManager.kill(ship.id);
      }
    }
    // Also kill any processes tracked in runtime that may not be in DB yet
    for (const [id] of this.runtime) {
      this.processManager.kill(id);
    }
  }

  /**
   * Persist a ship's state to the database.
   * Throws on failure — callers MUST handle the error to prevent orphan processes.
   */
  private persistToDb(ship: ShipProcess): void {
    if (!this.fleetDb) return;
    this.fleetDb.upsertShip(ship);
  }

  /**
   * Restore ships from the database.
   * Called during startup reconciliation to recover active ship data
   * that was lost when the Engine process restarted.
   * Creates runtime entries for restored ships.
   */
  async restoreFromDisk(): Promise<number> {
    if (!this.fleetDb) return 0;
    try {
      const persisted = this.fleetDb.getActiveShips();
      let restored = 0;
      for (const ship of persisted) {
        // Skip if a runtime entry already exists
        if (this.runtime.has(ship.id)) continue;

        this.runtime.set(ship.id, {
          isCompacting: false,
          lastOutputAt: null,
          processDead: false,
          gateCheck: null,
          prReviewStatus: null,
          retryCount: 0,
        });
        restored++;
      }
      if (restored > 0) {
        console.log(`[ship-manager] Restored ${restored} ship(s) from database`);
      }
      return restored;
    } catch (err) {
      console.warn("[ship-manager] Failed to restore ships from database:", err);
      return 0;
    }
  }

  /**
   * Merge runtime state onto a DB-sourced ShipProcess.
   * Runtime fields override the DB defaults.
   */
  private mergeRuntime(dbShip: ShipProcess): ShipProcess {
    const rt = this.runtime.get(dbShip.id);
    if (!rt) return dbShip;
    return {
      ...dbShip,
      isCompacting: rt.isCompacting,
      lastOutputAt: rt.lastOutputAt,
      processDead: rt.processDead,
      gateCheck: rt.gateCheck,
      prReviewStatus: rt.prReviewStatus ?? dbShip.prReviewStatus,
      retryCount: rt.retryCount,
    };
  }

  /**
   * Ensure a runtime entry exists for a ship ID. Creates one with defaults if missing.
   */
  private ensureRuntime(shipId: string): ShipRuntime | undefined {
    let rt = this.runtime.get(shipId);
    if (!rt) {
      // Verify the ship exists in DB before creating runtime
      if (!this.fleetDb?.getShipById(shipId)) return undefined;
      rt = {
        isCompacting: false,
        lastOutputAt: null,
        processDead: false,
        gateCheck: null,
        prReviewStatus: null,
        retryCount: 0,
      };
      this.runtime.set(shipId, rt);
    }
    return rt;
  }
}
