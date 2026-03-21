import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { ProcessManager } from "./process-manager.js";
import { AcceptanceWatcher } from "./acceptance-watcher.js";
import type { StatusManager } from "./status-manager.js";
import * as github from "./github.js";
import * as worktree from "./worktree.js";
import type { ShipProcess, ShipStatus, FleetSkillSources, GateTransition, GateType, GateFileResponse, PersistedShip } from "./types.js";

const SHIPS_FILE = join(homedir(), ".vibe-admiral", "ships.json");

const execFileAsync = promisify(execFile);

export class ShipManager {
  private ships = new Map<string, ShipProcess>();
  private processManager: ProcessManager;
  private acceptanceWatcher: AcceptanceWatcher;
  private statusManager: StatusManager;
  private onStatusChange:
    | ((id: string, status: ShipStatus, detail?: string) => void)
    | null = null;

  constructor(
    processManager: ProcessManager,
    acceptanceWatcher: AcceptanceWatcher,
    statusManager: StatusManager,
  ) {
    this.processManager = processManager;
    this.acceptanceWatcher = acceptanceWatcher;
    this.statusManager = statusManager;
  }

  setStatusChangeHandler(
    handler: (id: string, status: ShipStatus, detail?: string) => void,
  ): void {
    this.onStatusChange = handler;
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
    // Clean up all completed ships (done/error) on every new sortie
    for (const [id, ship] of this.ships) {
      if (ship.status === "done" || ship.status === "error") {
        this.ships.delete(id);
      }
    }

    const shipId = randomUUID();

    // 1. Get issue info (used later for title, slug, etc.)
    const issue = await github.getIssue(repo, issueNumber);

    // 2. Update issue status: todo → doing (via StatusManager)
    await this.statusManager.markDoing(repo, issueNumber);

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
      status: "planning",
      isCompacting: false,
      branchName,
      worktreePath,
      sessionId: null,
      prUrl: existingPrUrl,
      prReviewStatus: existingPrReviewStatus,
      acceptanceTest: null,
      acceptanceTestApproved: false,
      gateCheck: null,
      qaRequired: true,
      errorType: null,
      retryCount: 0,
      createdAt: new Date().toISOString(),
      lastOutputAt: null,
    };
    this.ships.set(shipId, ship);

    // 8. Build extra context for Ship if there's an existing PR
    const prContext = existingPrUrl
      ? `\n\n[Prior Work Context] An existing PR was found for this branch: ${existingPrUrl}. The branch contains previous commits from a prior sortie. Check for existing work before starting from scratch. Run \`gh pr view --json number,url,body,reviews,comments\` to review the PR history.`
      : "";
    const fullExtraPrompt = extraPrompt
      ? `${extraPrompt}${prContext}`
      : prContext || undefined;

    // 9. Launch Claude CLI process
    this.processManager.sortie(shipId, worktreePath, issueNumber, fullExtraPrompt, skill);

    // 10. Start acceptance test watcher
    this.acceptanceWatcher.watch(worktreePath, shipId);

    this.updateStatus(shipId, "planning");
    return ship;
  }

  stopShip(shipId: string): boolean {
    const killed = this.processManager.kill(shipId);
    if (killed) {
      this.acceptanceWatcher.unwatch(shipId);
      const ship = this.ships.get(shipId);
      if (ship) ship.isCompacting = false;
      this.updateStatus(shipId, "error", "Manually stopped");
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
        if (ship.issueNumber === issueNumber && ship.status !== "done" && ship.status !== "error") {
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
      if (ship.repo === repo && ship.issueNumber === issueNumber && ship.status !== "done" && ship.status !== "error") {
        return ship;
      }
    }
    return undefined;
  }

  getActiveShipIssueNumbers(): Array<{ repo: string; issueNumber: number }> {
    const active: Array<{ repo: string; issueNumber: number }> = [];
    for (const ship of this.ships.values()) {
      if (ship.status !== "done" && ship.status !== "error") {
        active.push({ repo: ship.repo, issueNumber: ship.issueNumber });
      }
    }
    return active;
  }

  hasRunningProcess(shipId: string): boolean {
    return this.processManager.isRunning(shipId);
  }

  updateStatus(id: string, status: ShipStatus, detail?: string): void {
    const ship = this.ships.get(id);
    if (ship) {
      // Defensive: clear acceptanceTest when leaving acceptance-test status
      if (ship.status === "acceptance-test" && status !== "acceptance-test") {
        ship.acceptanceTest = null;
      }
      ship.status = status;
      if (status === "done" || status === "error") {
        ship.completedAt = Date.now();
      }
      // Note: GitHub label sync is now handled transactionally by ShipRequestHandler.
      // This method only updates in-memory state and notifies the frontend.
      this.onStatusChange?.(id, status, detail);
      this.persistToDisk();
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

  setAcceptanceTest(
    shipId: string,
    request: { url: string; checks: string[] },
  ): void {
    const ship = this.ships.get(shipId);
    if (!ship) return;
    ship.acceptanceTest = request;
  }

  clearAcceptanceTest(shipId: string): void {
    const ship = this.ships.get(shipId);
    if (!ship) return;
    ship.acceptanceTest = null;
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

  respondToAcceptanceTest(
    shipId: string,
    accepted: boolean,
    feedback?: string,
  ): void {
    const ship = this.ships.get(shipId);
    if (!ship) return;

    if (accepted) {
      ship.acceptanceTestApproved = true;
    }

    this.acceptanceWatcher
      .respond(ship.worktreePath, { accepted, feedback })
      .catch((err) => {
        console.error(
          `Failed to write acceptance test response for ${shipId}:`,
          err,
        );
      });
  }

  setGateCheck(
    shipId: string,
    transition: GateTransition,
    gateType: GateType,
  ): void {
    const ship = this.ships.get(shipId);
    if (!ship) return;
    ship.gateCheck = {
      transition,
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

  async respondToGate(
    shipId: string,
    approved: boolean,
    feedback?: string,
  ): Promise<void> {
    const ship = this.ships.get(shipId);
    if (!ship || !ship.gateCheck) return;

    ship.gateCheck.status = approved ? "approved" : "rejected";
    if (feedback) ship.gateCheck.feedback = feedback;

    // Write gate-response.json for Ship CLI to poll
    const claudeDir = join(ship.worktreePath, ".claude");
    await mkdir(claudeDir, { recursive: true });
    const response: GateFileResponse = { approved, feedback };
    await writeFile(
      join(claudeDir, "gate-response.json"),
      JSON.stringify(response, null, 2),
    );
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
   * Remove completed/error Ships that have no running process.
   * Called during startup reconciliation to clear ghosts from previous runs.
   */
  purgeOrphanShips(): number {
    let purged = 0;
    for (const [id, ship] of this.ships) {
      if (
        (ship.status === "done" || ship.status === "error") &&
        !this.processManager.isRunning(id)
      ) {
        this.ships.delete(id);
        purged++;
      }
    }
    if (purged > 0) {
      console.log(`[ship-manager] Purged ${purged} orphan ship(s)`);
      this.persistToDisk();
    }
    return purged;
  }

  /**
   * Retry an errored Ship. If the Ship has a sessionId, resume the session.
   * Otherwise, re-sortie from scratch.
   * Returns the resumed/re-launched ShipProcess, or null if not retryable.
   */
  retryShip(
    shipId: string,
    extraPrompt?: string,
    skill?: string,
  ): ShipProcess | null {
    const ship = this.ships.get(shipId);
    if (!ship || ship.status !== "error") return null;

    ship.retryCount++;
    ship.errorType = null;

    if (ship.sessionId) {
      // Resume existing session
      this.processManager.resumeSession(
        shipId,
        ship.sessionId,
        "The previous session was interrupted. Continue from where you left off.",
        ship.worktreePath,
      );
      this.updateStatus(shipId, "implementing", "Resumed from session");
    } else {
      // No session to resume — re-sortie
      this.processManager.sortie(
        shipId,
        ship.worktreePath,
        ship.issueNumber,
        extraPrompt,
        skill,
      );
      this.updateStatus(shipId, "planning", "Re-sortied");
    }

    this.acceptanceWatcher.watch(ship.worktreePath, shipId);
    return ship;
  }

  stopAll(): void {
    for (const [id] of this.ships) {
      this.processManager.kill(id);
    }
    this.acceptanceWatcher.unwatchAll();
  }

  /**
   * Persist active ships to disk so reconcileOnStartup can identify
   * genuinely active ships after an Engine restart.
   * Only ships with non-terminal statuses are persisted.
   */
  private persistToDisk(): void {
    const active: PersistedShip[] = [];
    for (const ship of this.ships.values()) {
      if (ship.status !== "done" && ship.status !== "error") {
        active.push({
          id: ship.id,
          fleetId: ship.fleetId,
          repo: ship.repo,
          issueNumber: ship.issueNumber,
          issueTitle: ship.issueTitle,
          worktreePath: ship.worktreePath,
          branchName: ship.branchName,
          sessionId: ship.sessionId,
          status: ship.status,
          createdAt: ship.createdAt,
        });
      }
    }
    // Fire-and-forget: persistence is best-effort, don't block the caller
    const dir = join(homedir(), ".vibe-admiral");
    mkdir(dir, { recursive: true })
      .then(() => writeFile(SHIPS_FILE, JSON.stringify(active, null, 2)))
      .catch((err) => {
        console.warn("[ship-manager] Failed to persist ships to disk:", err);
      });
  }

  /**
   * Restore ships from disk persistence file.
   * Called during startup reconciliation to recover active ship data
   * that was lost when the Engine process restarted.
   * Restored ships are added to the in-memory Map so that
   * getActiveShipIssueNumbers() returns them during reconciliation.
   */
  async restoreFromDisk(): Promise<number> {
    try {
      const content = await readFile(SHIPS_FILE, "utf-8");
      const persisted = JSON.parse(content) as PersistedShip[];
      let restored = 0;
      for (const ps of persisted) {
        // Skip if a ship with this ID already exists in memory
        if (this.ships.has(ps.id)) continue;
        // Only restore ships that had active (non-terminal) statuses
        if (ps.status === "done" || ps.status === "error") continue;

        const ship: ShipProcess = {
          id: ps.id,
          fleetId: ps.fleetId,
          repo: ps.repo,
          issueNumber: ps.issueNumber,
          issueTitle: ps.issueTitle,
          worktreePath: ps.worktreePath,
          branchName: ps.branchName,
          sessionId: ps.sessionId,
          status: ps.status,
          isCompacting: false,
          prUrl: null,
          prReviewStatus: null,
          acceptanceTest: null,
          acceptanceTestApproved: false,
          gateCheck: null,
          qaRequired: true,
          errorType: null,
          retryCount: 0,
          createdAt: ps.createdAt,
          lastOutputAt: null,
        };
        this.ships.set(ps.id, ship);
        restored++;
      }
      if (restored > 0) {
        console.log(`[ship-manager] Restored ${restored} ship(s) from disk`);
      }
      return restored;
    } catch {
      // File doesn't exist or is invalid — normal on first run
      return 0;
    }
  }
}
