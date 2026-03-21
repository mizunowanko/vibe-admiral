import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ProcessManager } from "./process-manager.js";
import type { StatusManager } from "./status-manager.js";
import type { FleetDatabase } from "./db.js";
import * as github from "./github.js";
import * as worktree from "./worktree.js";
import type { ShipProcess, Phase, FleetSkillSources, GatePhase, GateType, DbMessageType } from "./types.js";

const execFileAsync = promisify(execFile);

export class ShipManager {
  private ships = new Map<string, ShipProcess>();
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
    for (const [id, ship] of this.ships) {
      if (ship.phase === "done") {
        this.ships.delete(id);
        this.fleetDb?.deleteShip(id);
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

    // 6. npm install if web project
    if (await worktree.isWebProject(worktreePath)) {
      await execFileAsync("npm", ["install"], { cwd: worktreePath });
    }

    // 7. Detect existing PR for branch reuse (preserves review history)
    let existingPrUrl: string | null = null;
    let existingPrReviewStatus: "pending" | null = null;
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
    this.ships.set(shipId, ship);
    this.persistToDb(ship);

    // 8. Build extra context for Ship
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

    // 9. Launch Claude CLI process with DB path for message polling
    const shipEnv: Record<string, string> = {
      VIBE_ADMIRAL_MAIN_REPO: repo,
    };
    if (this.fleetDb) {
      shipEnv.VIBE_ADMIRAL_DB_PATH = this.fleetDb.path;
    }
    this.processManager.sortie(shipId, worktreePath, issueNumber, fullExtraPrompt, skill, shipEnv);

    this.updatePhase(shipId, "planning");
    return ship;
  }

  stopShip(shipId: string): boolean {
    const killed = this.processManager.kill(shipId);
    if (killed) {
      const ship = this.ships.get(shipId);
      if (ship) ship.isCompacting = false;
      this.updatePhase(shipId, "done", "Manually stopped");
    }
    return killed;
  }

  getShip(shipId: string): ShipProcess | undefined {
    return this.ships.get(shipId);
  }

  /**
   * Resolve a Ship by: exact UUID → prefix match → issueNumber fallback.
   * Returns undefined if no match or if a prefix matches multiple ships.
   */
  resolveShip(shipId: string, issueNumber?: number): ShipProcess | undefined {
    // 1. Exact match
    const exact = this.ships.get(shipId);
    if (exact) return exact;

    // 2. Prefix match (only if shipId is shorter than a full UUID)
    if (shipId.length < 36) {
      const prefixMatches: ShipProcess[] = [];
      for (const ship of this.ships.values()) {
        if (ship.id.startsWith(shipId)) {
          prefixMatches.push(ship);
        }
      }
      if (prefixMatches.length === 1) return prefixMatches[0];
    }

    // 3. issueNumber fallback (active ships only)
    if (issueNumber !== undefined) {
      for (const ship of this.ships.values()) {
        if (ship.issueNumber === issueNumber && ship.phase !== "done") {
          return ship;
        }
      }
    }

    return undefined;
  }

  getShipsByFleet(fleetId: string): ShipProcess[] {
    return Array.from(this.ships.values()).filter(
      (s) => s.fleetId === fleetId,
    );
  }

  getAllShips(): ShipProcess[] {
    return Array.from(this.ships.values());
  }

  getShipByIssue(repo: string, issueNumber: number): ShipProcess | undefined {
    for (const ship of this.ships.values()) {
      if (ship.repo === repo && ship.issueNumber === issueNumber && ship.phase !== "done") {
        return ship;
      }
    }
    return undefined;
  }

  getActiveShipIssueNumbers(): Array<{ repo: string; issueNumber: number }> {
    const active: Array<{ repo: string; issueNumber: number }> = [];
    for (const ship of this.ships.values()) {
      if (ship.phase !== "done") {
        active.push({ repo: ship.repo, issueNumber: ship.issueNumber });
      }
    }
    return active;
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
    const ship = this.ships.get(shipId);
    if (!ship) return;
    ship.processDead = true;
    // Trigger notification without changing the phase — the UI derives
    // "process dead" from phase ≠ done && processDead flag.
    this.onPhaseChange?.(shipId, ship.phase, "Process dead");
  }

  updatePhase(id: string, phase: Phase, detail?: string): void {
    const ship = this.ships.get(id);
    if (ship) {
      const previousPhase = ship.phase;
      ship.phase = phase;
      if (phase === "done") {
        ship.completedAt = Date.now();
      }
      // Note: GitHub label sync is now handled transactionally by ShipRequestHandler.
      // This method only updates in-memory state and notifies the frontend.
      this.onPhaseChange?.(id, phase, detail);
      this.persistToDb(ship, previousPhase);
    }
  }

  setQaRequired(id: string, qaRequired: boolean): void {
    const ship = this.ships.get(id);
    if (ship) {
      ship.qaRequired = qaRequired;
    }
  }

  setNothingToDo(id: string, reason: string): void {
    const ship = this.ships.get(id);
    if (ship) {
      ship.nothingToDo = true;
      ship.nothingToDoReason = reason;
    }
  }

  respondToPRReview(
    shipId: string,
    result: { verdict: "approve" | "request-changes"; comments?: string },
  ): void {
    const ship = this.ships.get(shipId);
    if (!ship) return;
    ship.prReviewStatus =
      result.verdict === "approve" ? "approved" : "changes-requested";
  }

  setGateCheck(
    shipId: string,
    gatePhase: GatePhase,
    gateType: GateType,
  ): void {
    const ship = this.ships.get(shipId);
    if (!ship) return;
    ship.gateCheck = {
      gatePhase,
      gateType,
      status: "pending",
      requestedAt: new Date().toISOString(),
    };
  }

  clearGateCheck(shipId: string): void {
    const ship = this.ships.get(shipId);
    if (!ship) return;
    ship.gateCheck = null;
  }

  writeDbMessage(
    shipId: string,
    type: DbMessageType,
    sender: string,
    payload: Record<string, unknown>,
  ): void {
    if (!this.fleetDb) {
      console.warn("[ship-manager] Cannot write DB message: no database");
      return;
    }
    this.fleetDb.insertMessage(shipId, type, sender, payload);
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
      // Gate skills (Ship launches its own Escort sub-agents)
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
    let purged = 0;
    for (const [id, ship] of this.ships) {
      if (
        ship.phase === "done" &&
        !this.processManager.isRunning(id)
      ) {
        this.ships.delete(id);
        this.fleetDb?.deleteShip(id);
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
    const ship = this.ships.get(shipId);
    if (!ship) return null;

    // Only retry if the process is dead and phase is not terminal
    if (ship.phase === "done" || this.processManager.isRunning(shipId)) {
      return null;
    }

    ship.retryCount++;
    ship.processDead = false;

    // Build extra env vars for the Ship process
    const shipEnv: Record<string, string> = {
      VIBE_ADMIRAL_MAIN_REPO: ship.repo,
    };
    if (this.fleetDb) {
      shipEnv.VIBE_ADMIRAL_DB_PATH = this.fleetDb.path;
    }

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

    return ship;
  }

  stopAll(): void {
    for (const [id] of this.ships) {
      this.processManager.kill(id);
    }
  }

  /**
   * Persist a ship's state to the database after a phase change.
   * Records the phase transition in the audit log.
   */
  private persistToDb(ship: ShipProcess, previousPhase?: Phase): void {
    if (!this.fleetDb) return;
    try {
      this.fleetDb.upsertShip(ship);
      if (previousPhase && previousPhase !== ship.phase) {
        this.fleetDb.recordPhaseTransition(
          ship.id,
          previousPhase,
          ship.phase,
          "engine",
        );
      }
    } catch (err) {
      console.warn("[ship-manager] Failed to persist ship to database:", err);
    }
  }

  /**
   * Restore ships from the database.
   * Called during startup reconciliation to recover active ship data
   * that was lost when the Engine process restarted.
   * Restored ships are added to the in-memory Map so that
   * getActiveShipIssueNumbers() returns them during reconciliation.
   */
  async restoreFromDisk(): Promise<number> {
    if (!this.fleetDb) return 0;
    try {
      const persisted = this.fleetDb.getActiveShips();
      let restored = 0;
      for (const ship of persisted) {
        // Skip if a ship with this ID already exists in memory
        if (this.ships.has(ship.id)) continue;

        this.ships.set(ship.id, ship);
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
}
