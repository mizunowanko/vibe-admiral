import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProcessManager } from "./process-manager.js";
import { parseStreamMessage } from "./stream-parser.js";
import type { StatusManager } from "./status-manager.js";
import type { FleetDatabase } from "./db.js";
import type { ShipActorManager } from "./ship-actor-manager.js";
import * as github from "./github.js";
import * as worktree from "./worktree.js";
import type { ShipProcess, Phase, FleetSkillSources, GatePhase, GateType, GateCheckState, PRReviewStatus, StreamMessage } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Minimal CLAUDE.md for Ships working on external repos.
 * Only includes VIBE_ADMIRAL environment variable documentation
 * and basic tool constraints — no vibe-admiral-specific architecture or terminology.
 */
const SHIP_MINIMAL_CLAUDE_MD = `# Ship Context

This Ship is managed by vibe-admiral. Use the /implement skill to execute the workflow.

## Environment Variables

- \`VIBE_ADMIRAL=true\` — Running inside Admiral (worktree/label management handled externally)
- \`VIBE_ADMIRAL_SHIP_ID\` — This Ship's unique ID
- \`VIBE_ADMIRAL_MAIN_REPO\` — The fleet's main repository (owner/repo)
- \`VIBE_ADMIRAL_ENGINE_PORT\` — Engine API port (default: 9721)

## Rate Limit vs Polling vs Machine Sleep

- **Rate limit**: stderr に \`429\` / \`rate_limit_error\` が出る。全 Unit が同時に停止する。
- **ポーリング sleep**: スキル内の意図的な待機。エラーは出ない。
- **マシンスリープ復帰**: 応答遅延するがエラーメッセージはない。1 Unit だけの遅延なら rate limit ではない。

rate limit でない遅延に対して不要な待機やリトライを行わないこと。

## Constraints

- Do not modify \`.env\` files
- Use Engine REST API for phase transitions (see /admiral-protocol skill)
`;

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
  private actorManager: ShipActorManager | null = null;
  private onPhaseChange:
    | ((id: string, phase: Phase, detail?: string) => void)
    | null = null;
  private onShipCreated:
    | ((id: string) => void)
    | null = null;

  constructor(
    processManager: ProcessManager,
    statusManager: StatusManager,
  ) {
    this.processManager = processManager;
    this.statusManager = statusManager;
  }

  setActorManager(actorManager: ShipActorManager): void {
    this.actorManager = actorManager;
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

  setShipCreatedHandler(handler: (id: string) => void): void {
    this.onShipCreated = handler;
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
    // Collect re-sortie context from previous Ship BEFORE deleting it.
    // This preserves phase history & workflow state for the new Ship.
    let reSortieContext: string | null = null;
    if (this.fleetDb) {
      const existingShip = this.fleetDb.getShipByIssueAnyPhase(repo, issueNumber);
      if (existingShip && (existingShip.phase === "done" || existingShip.phase === "stopped")) {
        reSortieContext = await this.collectReSortieContext(existingShip);
        this.runtime.delete(existingShip.id);
        this.fleetDb.deleteShip(existingShip.id);
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

    // 5b. Write minimal CLAUDE.md for external repos (overrides vibe-admiral's CLAUDE.md)
    await this.deployCLAUDEmd(repoRoot, worktreePath);

    // 6. Remove stale .claude work files from previous sortie (or inherited from main)
    const staleFiles = [
      "workflow-state.json",
      "ship-log.jsonl",
      "escort-log.jsonl",
      "gate-request.json",
      "gate-response.json",
    ];
    await Promise.all(
      staleFiles.map((f) => unlink(join(worktreePath, ".claude", f)).catch(() => {})),
    );

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
      kind: "ship",
      parentShipId: null,
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
    const fullExtraPrompt = [issueContext, extraPrompt, prContext, reSortieContext]
      .filter(Boolean)
      .join("\n\n") || undefined;

    // 10. Create XState Actor for this Ship
    this.actorManager?.createActor({
      shipId,
      fleetId,
      repo,
      issueNumber,
      worktreePath,
      branchName,
      sessionId: null,
      prUrl: existingPrUrl,
      qaRequired: true,
    });

    // 11. Launch Claude CLI process with Engine API access
    const shipEnv: Record<string, string> = {
      VIBE_ADMIRAL_MAIN_REPO: repo,
      VIBE_ADMIRAL_SHIP_ID: shipId,
      VIBE_ADMIRAL_ENGINE_PORT: process.env.ENGINE_PORT ?? "9721",
    };
    this.processManager.sortie(shipId, worktreePath, issueNumber, fullExtraPrompt, skill, shipEnv);

    this.updatePhase(shipId, "planning");
    this.onShipCreated?.(shipId);
    return ship;
  }

  /**
   * Collect context from a previous Ship's DB records and worktree state
   * so the new Ship can resume from where the previous one left off.
   * Called BEFORE the previous Ship record is deleted from DB.
   */
  private async collectReSortieContext(
    previousShip: ShipProcess,
  ): Promise<string | null> {
    const parts: string[] = [];

    // 1. Phase history from DB
    let lastPhase: Phase | null = null;
    let phaseHistory = "";
    if (this.fleetDb) {
      lastPhase = this.fleetDb.getPhaseBeforeStopped(previousShip.id) ?? (previousShip.phase as Phase);
      const transitions = this.fleetDb.getPhaseTransitions(previousShip.id, 20);
      if (transitions.length > 0) {
        phaseHistory = transitions
          .reverse()
          .map((t) => `  ${t.fromPhase ?? "(init)"} → ${t.toPhase}`)
          .join("\n");
      }
    }

    // 2. Workflow state from worktree (read before stale file cleanup)
    let workflowState: string | null = null;
    try {
      workflowState = await readFile(
        join(previousShip.worktreePath, ".claude", "workflow-state.json"),
        "utf-8",
      );
    } catch {
      // No workflow state file — fresh or already cleaned
    }

    // 3. Git state from worktree
    let gitLog = "";
    let gitStatus = "";
    try {
      const { stdout: logOut } = await execFileAsync(
        "git", ["log", "--oneline", "main..HEAD", "--max-count=20"],
        { cwd: previousShip.worktreePath },
      );
      gitLog = logOut.trim();
    } catch {
      // Branch may not exist yet
    }
    try {
      const { stdout: statusOut } = await execFileAsync(
        "git", ["status", "--porcelain"],
        { cwd: previousShip.worktreePath },
      );
      gitStatus = statusOut.trim();
    } catch {
      // Worktree may not exist
    }

    // 4. Map last phase to suggested /implement step
    const phaseToStep: Record<string, number> = {
      planning: 3,
      "planning-gate": 3,
      implementing: 5,
      "implementing-gate": 5,
      "acceptance-test": 11,
      "acceptance-test-gate": 11,
      merging: 15,
    };
    const suggestedStep = lastPhase ? phaseToStep[lastPhase] ?? 3 : 3;

    // Build the context block
    parts.push("[Re-sortie Context] This is a re-sortie. A previous Ship worked on this issue but did not complete.");
    parts.push(`Previous Ship reached phase: ${lastPhase ?? previousShip.phase}`);
    parts.push(`Suggested /implement start step: ${suggestedStep}`);

    if (phaseHistory) {
      parts.push(`\nPhase transition history:\n${phaseHistory}`);
    }

    if (workflowState) {
      parts.push(`\nPrevious workflow-state.json:\n${workflowState}`);
    }

    if (gitLog) {
      parts.push(`\nExisting commits on branch (main..HEAD):\n${gitLog}`);
    }

    if (gitStatus) {
      parts.push(`\nUncommitted changes in worktree:\n${gitStatus}`);
    } else if (gitLog) {
      parts.push("\nNo uncommitted changes in worktree.");
    }

    parts.push("\nUse the previous work. Do not start from scratch. If workflow-state.json was provided, use its currentStep to resume. Otherwise use the suggested start step.");

    const context = parts.join("\n");
    console.log(`[ship-manager] Re-sortie context collected for issue #${previousShip.issueNumber} (prev phase: ${lastPhase ?? previousShip.phase}, step: ${suggestedStep})`);
    return context;
  }

  /**
   * Launch a new Escort for the first gate. Creates a fresh Escort Ship record
   * and launches the `/escort` skill with the gate phase as context.
   *
   * Reuses the parent Ship's worktree, branch, and repo — skips worktree
   * creation, skill deployment, npm install, issue label changes, and PR detection.
   */
  sortieEscort(parentShip: ShipProcess, gatePhase?: GatePhase, extraPrompt?: string): ShipProcess {
    const escortId = randomUUID();

    const escort: ShipProcess = {
      id: escortId,
      fleetId: parentShip.fleetId,
      repo: parentShip.repo,
      issueNumber: parentShip.issueNumber,
      issueTitle: parentShip.issueTitle,
      phase: "planning",
      isCompacting: false,
      branchName: parentShip.branchName,
      worktreePath: parentShip.worktreePath,
      sessionId: null,
      prUrl: null,
      prReviewStatus: null,
      gateCheck: null,
      qaRequired: false,
      retryCount: 0,
      createdAt: new Date().toISOString(),
      lastOutputAt: null,
      kind: "escort",
      parentShipId: parentShip.id,
    };

    // Persist to DB
    try {
      this.persistToDb(escort);
    } catch (err) {
      console.error(`[ship-manager] DB INSERT failed for escort ${escortId} (parent: ${parentShip.id.slice(0, 8)}...):`, err);
      throw new Error(`Failed to persist escort to DB: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Store runtime state
    this.runtime.set(escortId, {
      isCompacting: false,
      lastOutputAt: null,
      processDead: false,
      gateCheck: null,
      prReviewStatus: null,
      retryCount: 0,
    });

    // Create XState Actor
    this.actorManager?.createActor({
      shipId: escortId,
      fleetId: parentShip.fleetId,
      repo: parentShip.repo,
      issueNumber: parentShip.issueNumber,
      worktreePath: parentShip.worktreePath,
      branchName: parentShip.branchName,
      sessionId: null,
      prUrl: null,
      qaRequired: false,
    });

    // Launch via processManager.sortie() with /escort skill + gate phase context
    const escortEnv: Record<string, string> = {
      VIBE_ADMIRAL_MAIN_REPO: parentShip.repo,
      VIBE_ADMIRAL_SHIP_ID: escortId,
      VIBE_ADMIRAL_ENGINE_PORT: process.env.ENGINE_PORT ?? "9721",
      VIBE_ADMIRAL_PARENT_SHIP_ID: parentShip.id,
    };

    const gateContext = gatePhase
      ? `\n\n[Gate Context] The parent Ship is currently in ${gatePhase}. Execute the ${gatePhase} review, submit the verdict, and exit.`
      : "";

    this.processManager.sortie(
      escortId,
      parentShip.worktreePath,
      parentShip.issueNumber,
      [extraPrompt, gateContext].filter(Boolean).join("\n\n") || undefined,
      "/escort",
      escortEnv,
    );

    console.log(
      `[ship-manager] Launched new Escort ${escortId.slice(0, 8)}... for Ship ${parentShip.id.slice(0, 8)}... at ${gatePhase ?? "unknown"} gate (issue #${parentShip.issueNumber})`,
    );

    return escort;
  }

  /**
   * Resume an existing Escort for a subsequent gate phase.
   * Uses `--resume sessionId` to preserve context from prior gate reviews
   * (e.g., planning review insights carry over to code review).
   */
  resumeEscort(
    existingEscort: ShipProcess,
    gatePhase: GatePhase,
  ): ShipProcess {
    if (!existingEscort.sessionId) {
      throw new Error(`Cannot resume Escort ${existingEscort.id.slice(0, 8)}... — no sessionId`);
    }

    const escortId = existingEscort.id;

    // Reset runtime state for the new gate
    const rt = this.ensureRuntime(escortId);
    if (rt) {
      rt.processDead = false;
      rt.isCompacting = false;
    }

    // Build Escort env vars
    const escortEnv: Record<string, string> = {
      VIBE_ADMIRAL_MAIN_REPO: existingEscort.repo,
      VIBE_ADMIRAL_SHIP_ID: escortId,
      VIBE_ADMIRAL_ENGINE_PORT: process.env.ENGINE_PORT ?? "9721",
      VIBE_ADMIRAL_PARENT_SHIP_ID: existingEscort.parentShipId!,
    };

    // Resume with gate context message
    const resumeMessage = `The parent Ship has entered ${gatePhase}. Execute the ${gatePhase} review, submit the verdict, and exit.`;

    this.processManager.resumeSession(
      escortId,
      existingEscort.sessionId,
      resumeMessage,
      existingEscort.worktreePath,
      escortEnv,
    );

    console.log(
      `[ship-manager] Resumed Escort ${escortId.slice(0, 8)}... (session: ${existingEscort.sessionId.slice(0, 12)}...) for ${gatePhase}`,
    );

    return this.getShip(escortId) ?? existingEscort;
  }

  /** Check if a Ship is an Escort by its kind field. */
  isEscort(shipId: string): boolean {
    const ship = this.getShip(shipId);
    return ship?.kind === "escort";
  }

  /** Get the Escort Ship for a parent Ship, if any. */
  getEscortForShip(parentShipId: string): ShipProcess | undefined {
    if (!this.fleetDb) return undefined;
    const allShips = this.fleetDb.getAllShips();
    const escort = allShips.find(
      (s) => s.kind === "escort" && s.parentShipId === parentShipId && s.phase !== "done",
    );
    return escort ? this.mergeRuntime(escort) : undefined;
  }

  stopShip(shipId: string): boolean {
    const killed = this.processManager.kill(shipId);
    if (killed) {
      const rt = this.runtime.get(shipId);
      if (rt) rt.isCompacting = false;
      this.actorManager?.send(shipId, { type: "STOP" });
      this.updatePhase(shipId, "stopped", "Manually stopped");
    }
    return killed;
  }

  /**
   * Abandon a Ship: transition from stopped → done.
   * Used for zombie cleanup when a Ship cannot be resumed.
   * Returns true if the ship was abandoned, false if not in "stopped" phase.
   */
  abandonShip(shipId: string): boolean {
    const ship = this.getShip(shipId);
    if (!ship || ship.phase !== "stopped") return false;

    // Kill process if somehow still running
    this.processManager.kill(shipId);

    this.actorManager?.send(shipId, { type: "ABANDON" });
    this.updatePhase(shipId, "done", "Abandoned (zombie cleanup)");
    return true;
  }

  /**
   * Delete a Ship from DB and runtime. For unrecoverable zombie cleanup.
   * Kills the process if running, removes runtime state, Actor, and DB record.
   * Returns true if the ship was deleted, false if not found.
   */
  deleteShip(shipId: string): boolean {
    const ship = this.getShip(shipId);
    if (!ship) return false;

    // Kill process if running
    this.processManager.kill(shipId);

    // Clean up runtime, Actor, and DB
    this.runtime.delete(shipId);
    this.actorManager?.stopActor(shipId);
    this.fleetDb?.deleteShip(shipId);
    return true;
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
    const ship = this.getShip(shipId);
    if (!ship) return;
    // Process death in "done" phase is expected — no notification needed
    if (ship.phase === "done") return;

    const rt = this.ensureRuntime(shipId);
    if (!rt) return;
    rt.processDead = true;
    this.actorManager?.send(shipId, { type: "PROCESS_DIED" });
    // Trigger notification without changing the phase — the UI derives
    // "process dead" from phase ≠ done && processDead flag.
    this.onPhaseChange?.(shipId, ship.phase, "Process dead");
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
      // Only notify when the phase actually changed
      if (previousPhase !== phase) {
        // Record phase transition
        try {
          this.fleetDb?.recordPhaseTransition(id, previousPhase, phase, "engine");
        } catch (err) {
          console.warn("[ship-manager] Failed to record phase transition:", err);
        }
        // Notify frontend
        this.onPhaseChange?.(id, phase, detail);
      }
    }
  }

  /**
   * Sync phase from DB and notify frontend.
   * Called by the REST API after it has already updated the DB via persistPhaseTransition().
   * Unlike updatePhase(), this does NOT write to DB — it only reads and notifies.
   */
  syncPhaseFromDb(id: string): void {
    const dbShip = this.fleetDb?.getShipById(id);
    if (dbShip) {
      this.onPhaseChange?.(id, dbShip.phase as Phase);
    }
  }

  /** Update a Ship's session ID (runtime + DB + Actor). */
  setSessionId(id: string, sessionId: string): void {
    this.fleetDb?.updateShipSessionId(id, sessionId);
    this.actorManager?.send(id, { type: "SET_SESSION_ID", sessionId });
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

  /** Update a Ship's lastOutputAt timestamp (runtime + Actor). */
  setLastOutputAt(id: string, timestamp: number): void {
    const rt = this.ensureRuntime(id);
    if (rt) rt.lastOutputAt = timestamp;
    this.actorManager?.send(id, { type: "PROCESS_OUTPUT", timestamp });
  }

  /** Update a Ship's isCompacting state (runtime + Actor). */
  setIsCompacting(id: string, isCompacting: boolean): void {
    const rt = this.ensureRuntime(id);
    if (rt) rt.isCompacting = isCompacting;
    this.actorManager?.send(id, { type: isCompacting ? "COMPACT_START" : "COMPACT_END" });
  }

  setQaRequired(id: string, qaRequired: boolean): void {
    if (!this.fleetDb) return;
    const dbShip = this.fleetDb.getShipById(id);
    if (dbShip) {
      dbShip.qaRequired = qaRequired;
      this.fleetDb.upsertShip(dbShip);
    }
    this.actorManager?.send(id, { type: "SET_QA_REQUIRED", qaRequired });
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

  /**
   * Check whether a file exists (non-throwing).
   */
  private async fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Deploy a single skill to the worktree, skipping if the repo already provides it.
   * Returns true if deployed, false if skipped (repo skill preserved).
   * When force=true, always overwrite (used by redeploySkills to refresh stale copies).
   */
  private async deploySkill(
    skillName: string,
    srcPath: string,
    worktreePath: string,
    force = false,
  ): Promise<boolean> {
    const dest = join(worktreePath, ".claude", "skills", skillName, "SKILL.md");

    // Preserve repo-specific skill: if the worktree already has this skill
    // (inherited from git tracked files), do not overwrite it.
    // When force=true, always overwrite — the Ship may have updated the skill source.
    if (!force && await this.fileExists(dest)) {
      console.log(`[ship-manager] Skipping /${skillName} — repo-specific skill preserved`);
      return false;
    }

    const destDir = join(worktreePath, ".claude", "skills", skillName);
    await mkdir(destDir, { recursive: true });
    await copyFile(srcPath, dest);
    return true;
  }

  private async deploySkills(
    repoRoot: string,
    worktreePath: string,
    skillSources?: FleetSkillSources,
    force = false,
  ): Promise<void> {
    // Resolve the Admiral skills directory.
    // admiralSkillsDir is auto-populated by resolveFleetContext(); fall back to
    // repoRoot/skills for backward compatibility (e.g., Admiral-only fleets).
    const admiralSkillsDir = skillSources?.admiralSkillsDir
      ?? join(repoRoot, "skills");

    // Deploy /implement orchestrator (essential for Ship operation).
    // skillSources.implement override takes priority over admiralSkillsDir.
    const implementSrc = skillSources?.implement
      ? join(skillSources.implement, "SKILL.md")
      : join(admiralSkillsDir, "implement", "SKILL.md");
    try {
      await this.deploySkill("implement", implementSrc, worktreePath, force);
    } catch (err) {
      // Fatal: /implement is required for Ship operation
      throw new Error(`Failed to deploy /implement skill: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Deploy Admiral sub-skills and shared skills (non-fatal individually)
    const admiralSkills = [
      // Ship sub-skills
      "implement-setup",
      "implement-plan",
      "implement-code",
      "implement-review",
      "implement-merge",
      // Gate skills (deployed to worktree for reference by Escort)
      "planning-gate",
      "implementing-gate",
      "acceptance-test-gate",
      // Persistent Escort skill (unified gate reviewer)
      "escort",
      // Shared skills (Bridge/Ship common)
      "admiral-protocol",
      "read-issue",
      // Other Admiral skills
      "adr",
    ];
    for (const skillName of admiralSkills) {
      const src = join(admiralSkillsDir, skillName, "SKILL.md");
      try {
        await this.deploySkill(skillName, src, worktreePath, force);
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
      try {
        await this.deploySkill(skillName, src, worktreePath, force);
      } catch {
        console.warn(`[ship-manager] Failed to deploy /${skillName} skill from dev-shared`);
      }
    }
  }

  /**
   * Re-deploy all skills to a Ship's worktree, overwriting stale copies.
   * Called before Escort launch at gate phase transitions so that skill
   * changes made by the Ship during implementation are picked up.
   */
  async redeploySkills(
    shipId: string,
    skillSources?: FleetSkillSources,
  ): Promise<void> {
    const ship = this.getShip(shipId);
    if (!ship) {
      console.warn(`[ship-manager] redeploySkills: Ship ${shipId.slice(0, 8)}... not found`);
      return;
    }
    const repoRoot = await worktree.getRepoRoot(ship.worktreePath);
    await this.deploySkills(repoRoot, ship.worktreePath, skillSources, true);
    console.log(`[ship-manager] Re-deployed skills to ${ship.worktreePath}`);
  }

  /**
   * For external repos, replace the inherited CLAUDE.md with a minimal Ship template.
   * Worktrees inherit CLAUDE.md from the git tree they branch from. When the
   * worktree's main repo (the repo that owns the .worktrees/ directory) differs
   * from the target repo (`localPath`), the inherited CLAUDE.md belongs to the
   * wrong project. In that case, copy the target repo's CLAUDE.md or write a
   * minimal Ship template.
   *
   * Detection: compare the worktree's main working tree (via `git worktree list`)
   * with `localPath`'s git root. If they differ, it's an external repo.
   */
  private async deployCLAUDEmd(
    repoRoot: string,
    worktreePath: string,
  ): Promise<void> {
    // Find the main working tree that owns this worktree.
    // `git worktree list --porcelain` lists the main tree first.
    let mainRepoRoot: string;
    try {
      const { stdout } = await execFileAsync(
        "git", ["worktree", "list", "--porcelain"],
        { cwd: worktreePath },
      );
      const firstLine = stdout.split("\n")[0] ?? "";
      mainRepoRoot = firstLine.replace("worktree ", "");
    } catch {
      // Cannot determine — assume worktree is within the correct repo
      return;
    }

    // If the main repo root matches localPath's repo root, the CLAUDE.md is correct
    if (mainRepoRoot === repoRoot) {
      return;
    }

    // Worktree belongs to a different repo than the target (e.g., vibe-admiral
    // hosts worktrees for external repos). Replace CLAUDE.md.
    const externalClaudeMd = join(repoRoot, "CLAUDE.md");
    const destClaudeMd = join(worktreePath, "CLAUDE.md");

    try {
      await copyFile(externalClaudeMd, destClaudeMd);
      console.log(`[ship-manager] Copied target repo CLAUDE.md to worktree`);
    } catch {
      // No CLAUDE.md in target repo — write minimal Ship template
      await writeFile(destClaudeMd, SHIP_MINIMAL_CLAUDE_MD);
      console.log(`[ship-manager] Wrote minimal CLAUDE.md for external repo Ship`);
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
        this.actorManager?.stopActor(ship.id);
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
      VIBE_ADMIRAL_ENGINE_PORT: process.env.ENGINE_PORT ?? "9721",
    };

    // Sync phaseBeforeStopped from DB into Actor context before RESUME,
    // so the RESUME guards have the correct phase to restore to.
    if (ship.phase === "stopped") {
      const phaseBeforeStopped = this.fleetDb?.getPhaseBeforeStopped(shipId);
      if (phaseBeforeStopped) {
        this.actorManager?.send(shipId, {
          type: "SET_PHASE_BEFORE_STOPPED",
          phase: phaseBeforeStopped,
        });
      }
    }

    // Send RESUME event to Actor (transitions from stopped to previous phase)
    this.actorManager?.send(shipId, { type: "RESUME" });

    if (ship.sessionId) {
      // Resume existing session
      this.processManager.resumeSession(
        shipId,
        ship.sessionId,
        "The previous session was interrupted. Continue from where you left off.",
        ship.worktreePath,
        shipEnv,
      );
      const previousPhase = this.fleetDb?.getPhaseBeforeStopped(shipId) ?? "implementing";
      this.updatePhase(shipId, previousPhase, `Resumed from session (restored to ${previousPhase})`);
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
    // Stop all XState Actors
    this.actorManager?.stopAll();
  }

  private static readonly MAX_SHIP_LOGS = 500;

  /**
   * Load Ship logs from the worktree's `.claude/ship-log.jsonl` file.
   * Returns the last MAX_SHIP_LOGS messages, or an empty array if the file doesn't exist.
   */
  async loadShipLogs(shipId: string, limit?: number): Promise<StreamMessage[]> {
    const ship = this.getShip(shipId);
    if (!ship) return [];

    const claudeDir = join(ship.worktreePath, ".claude");
    const shipLogPath = join(claudeDir, "ship-log.jsonl");
    const escortLogPath = join(claudeDir, "escort-log.jsonl");
    const maxLines = Math.min(limit ?? ShipManager.MAX_SHIP_LOGS, ShipManager.MAX_SHIP_LOGS);

    const parseJsonl = async (path: string): Promise<StreamMessage[]> => {
      try {
        const content = await readFile(path, "utf-8");
        const lines = content.trimEnd().split("\n").filter(Boolean);
        const msgs: StreamMessage[] = [];
        for (const line of lines) {
          try {
            const parsed = parseStreamMessage(JSON.parse(line));
            if (parsed) msgs.push(parsed);
          } catch {
            // Skip malformed lines
          }
        }
        return msgs;
      } catch {
        return [];
      }
    };

    const [shipMsgs, escortMsgs] = await Promise.all([
      parseJsonl(shipLogPath),
      parseJsonl(escortLogPath),
    ]);

    // Mark escort messages with escort-log metadata for visual distinction
    for (const msg of escortMsgs) {
      if (msg.type === "assistant") {
        msg.meta = { ...msg.meta, category: "escort-log" };
      }
    }

    // Merge and sort by timestamp, then take the last N messages
    const all = [...shipMsgs, ...escortMsgs];
    all.sort((a, b) => ((a.timestamp as number) ?? 0) - ((b.timestamp as number) ?? 0));
    return all.slice(-maxLines);
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

        // Restore XState Actor for this Ship
        // For stopped Ships, restore phaseBeforeStopped from DB so RESUME guards work
        const phaseBeforeStopped = ship.phase === "stopped"
          ? this.fleetDb?.getPhaseBeforeStopped(ship.id) ?? null
          : null;
        this.actorManager?.restoreActor(ship, phaseBeforeStopped);

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
