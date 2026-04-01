import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, copyFile, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { join } from "node:path";
import type { ProcessManagerLike } from "./process-manager.js";
import { parseStreamMessage } from "./stream-parser.js";
import type { StatusManager } from "./status-manager.js";
import type { FleetDatabase } from "./db.js";
import type { ShipActorManager } from "./ship-actor-manager.js";
import * as github from "./github.js";
import * as worktree from "./worktree.js";
import type { ShipProcess, Phase, FleetSkillSources, GatePhase, GateType, GateCheckState, PRReviewStatus, StreamMessage } from "./types.js";
import { isGatePhase, GATE_PREV_PHASE } from "./types.js";

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

## .claude/ Directory Write Restriction

Claude Code CLI blocks Write/Edit tools and shell redirects (\`>\`, \`>>\`) for \`.claude/\` directory (sensitive directory protection). This applies even with \`--dangerously-skip-permissions\`.

**Workaround**: Use Bash tool with \`tee\`, \`cp\`, \`sed -i\`, or \`mv\` to modify files in \`.claude/\`:
- Write: \`echo 'content' | tee .claude/rules/foo.md\`
- Copy: \`cp /tmp/draft.md .claude/skills/bar/SKILL.md\`
- Edit in-place: \`sed -i '' 's/old/new/g' .claude/rules/foo.md\`
- Multi-line write: \`cat <<'HEREDOC' | tee .claude/rules/foo.md\`

Read (via Read tool or \`cat\`) works normally for \`.claude/\` files.
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
  /** Timestamp (ms epoch) when the Ship process was last started/resumed. */
  lastStartedAt: number | null;
  /** Count of consecutive rapid deaths (process exiting shortly after start). */
  rapidDeathCount: number;
  /** Timestamp (ms epoch) when the Ship last hit a rate limit. Used for backoff on retry. */
  lastRateLimitAt: number | null;
}

export class ShipManager {
  /**
   * In-memory Map: stores only runtime/transient state per Ship.
   * Ship display data (phase, issueNumber, worktreePath, etc.) is read from DB.
   */
  private runtime = new Map<string, ShipRuntime>();
  private processManager: ProcessManagerLike;
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
    processManager: ProcessManagerLike,
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
    customInstructionsText?: string,
  ): Promise<ShipProcess> {
    // Collect re-sortie context from previous Ship BEFORE deleting it.
    // This preserves phase history & workflow state for the new Ship.
    let reSortieContext: string | null = null;
    let reSortieStartPhase: Phase | null = null;
    let previousShipId: string | null = null;
    if (this.fleetDb) {
      const existingShip = this.fleetDb.getShipByIssueAnyPhase(repo, issueNumber);
      if (existingShip && (existingShip.phase === "done" || existingShip.phase === "paused" || existingShip.phase === "abandoned")) {
        reSortieContext = await this.collectReSortieContext(existingShip);
        previousShipId = existingShip.id;

        // Determine the phase to start the new Ship at (#698).
        // Gate phases → restart at work phase before the gate (gate was interrupted).
        // Work phases → start at that phase directly (passed gates are skipped).
        const lastPhase = this.fleetDb.getPhaseBeforeStopped(existingShip.id) ?? (existingShip.phase as Phase);
        if (lastPhase !== "done" && lastPhase !== "paused" && lastPhase !== "abandoned") {
          reSortieStartPhase = isGatePhase(lastPhase)
            ? GATE_PREV_PHASE[lastPhase]
            : lastPhase;
        }

        this.runtime.delete(existingShip.id);
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

    // 5c. Persist customInstructions to .claude/rules/ so they survive context compaction.
    // Claude Code always reloads .claude/rules/*.md on every turn, unlike --append-system-prompt
    // which may be lost when the CLI compacts context mid-session.
    await this.deployCustomInstructions(worktreePath, customInstructionsText);

    // 5d. Deploy .claude/rules/ workaround for .claude/ directory write restriction (#752).
    // Claude Code blocks Write/Edit tools for .claude/ (sensitive directory) even with
    // --dangerously-skip-permissions. This rule file instructs Ships to use Bash alternatives.
    await this.deployClaudeDirAccessRule(worktreePath);

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

    // Re-sortie: transfer phase_transitions from old ship to new ship BEFORE
    // deleting the old ship. This preserves the full phase history chain (#698).
    if (previousShipId && this.fleetDb) {
      this.fleetDb.transferTransitionsForReSortie(previousShipId, shipId);
      this.fleetDb.deleteShip(previousShipId);
    }

    const initialPhase = reSortieStartPhase ?? "plan";
    const ship: ShipProcess = {
      id: shipId,
      fleetId,
      repo,
      issueNumber,
      issueTitle: issue.title,
      phase: initialPhase,
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
      lastStartedAt: Date.now(),
      rapidDeathCount: 0,
      lastRateLimitAt: null,
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

    // 10. Create XState Actor for this Ship.
    // Re-sortie: replay events to advance actor to the previous phase (#698).
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
    }, reSortieStartPhase ?? undefined);

    // 11. Launch Claude CLI process with Engine API access
    const shipEnv: Record<string, string> = {
      VIBE_ADMIRAL_MAIN_REPO: repo,
      VIBE_ADMIRAL_SHIP_ID: shipId,
      VIBE_ADMIRAL_ENGINE_PORT: process.env.ENGINE_PORT ?? "9721",
      VIBE_ADMIRAL_FLEET_ID: fleetId,
    };
    this.processManager.sortie(shipId, worktreePath, issueNumber, fullExtraPrompt, skill, shipEnv);

    this.updatePhase(shipId, initialPhase);
    if (reSortieStartPhase) {
      console.log(
        `[ship-manager] Re-sortie for issue #${issueNumber}: starting at phase "${initialPhase}" (previous ship: ${previousShipId?.slice(0, 8)}...)`,
      );
    }
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
      plan: 3,
      "plan-gate": 3,
      coding: 5,
      "coding-gate": 5,
      qa: 11,
      "qa-gate": 11,
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
      phase: "plan",
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
      lastStartedAt: Date.now(),
      rapidDeathCount: 0,
      lastRateLimitAt: null,
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
      VIBE_ADMIRAL_FLEET_ID: parentShip.fleetId,
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
      VIBE_ADMIRAL_FLEET_ID: existingEscort.fleetId,
    };

    // Resume with gate context message
    const resumeMessage = `The parent Ship has entered ${gatePhase}. Execute the ${gatePhase} review, submit the verdict, and exit.`;

    this.processManager.resumeSession(
      escortId,
      existingEscort.sessionId,
      resumeMessage,
      existingEscort.worktreePath,
      escortEnv,
      undefined,         // appendSystemPrompt
      "escort-log.jsonl", // Escort logs separated from ship-log.jsonl (#729)
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

  pauseShip(shipId: string): boolean {
    const killed = this.processManager.kill(shipId);
    if (killed) {
      const rt = this.runtime.get(shipId);
      if (rt) rt.isCompacting = false;
      this.actorManager?.send(shipId, { type: "PAUSE" });
      this.updatePhase(shipId, "paused", "Manually paused");
    }
    return killed;
  }

  /**
   * Abandon a Ship: transition from paused → abandoned.
   * Marks the Ship as permanently abandoned (not eligible for Resume All).
   * Returns true if the ship was abandoned, false if not in "paused" phase.
   */
  abandonShip(shipId: string): boolean {
    const ship = this.getShip(shipId);
    if (!ship || ship.phase !== "paused") return false;

    // Kill process if somehow still running
    this.processManager.kill(shipId);

    this.actorManager?.send(shipId, { type: "ABANDON" });
    this.updatePhase(shipId, "abandoned", "Abandoned");
    return true;
  }

  /**
   * Reactivate an abandoned Ship: transition from abandoned → paused.
   * Allows the Ship to be eligible for Resume All again.
   * Returns true if the ship was reactivated, false if not in "abandoned" phase.
   */
  reactivateShip(shipId: string): boolean {
    const ship = this.getShip(shipId);
    if (!ship || ship.phase !== "abandoned") return false;

    this.actorManager?.send(shipId, { type: "REACTIVATE" });
    this.updatePhase(shipId, "paused", "Reactivated from abandoned");
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

  /** Get the timestamp when the Ship process was last started/resumed. */
  getLastStartedAt(shipId: string): number | null {
    return this.runtime.get(shipId)?.lastStartedAt ?? null;
  }

  /** Get the current rapid death count for a Ship. */
  getRapidDeathCount(shipId: string): number {
    return this.runtime.get(shipId)?.rapidDeathCount ?? 0;
  }

  /** Increment the rapid death counter and return the new value. */
  incrementRapidDeathCount(shipId: string): number {
    const rt = this.ensureRuntime(shipId);
    if (!rt) return 0;
    rt.rapidDeathCount++;
    return rt.rapidDeathCount;
  }

  /** Reset the rapid death counter (called when process produces meaningful output). */
  resetRapidDeathCount(shipId: string): void {
    const rt = this.runtime.get(shipId);
    if (rt) rt.rapidDeathCount = 0;
  }

  /** Record that a Ship hit a rate limit. */
  setLastRateLimitAt(shipId: string, timestamp: number): void {
    const rt = this.ensureRuntime(shipId);
    if (rt) rt.lastRateLimitAt = timestamp;
  }

  /** Get the timestamp of the last rate limit hit, or null. */
  getLastRateLimitAt(shipId: string): number | null {
    return this.runtime.get(shipId)?.lastRateLimitAt ?? null;
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

    // Deploy Admiral sub-skills and shared skills (non-fatal individually).
    // Only Ship-essential skills are deployed at sortie time to minimize
    // token consumption (~9,350 tokens saved per Ship).
    // Escort-only skills are deployed on-demand before gate transitions
    // via deployEscortSkills().
    const admiralSkills = [
      // Ship sub-skills
      "implement-setup",
      "implement-plan",
      "implement-code",
      "implement-review",
      "implement-merge",
      // Shared skills (Bridge/Ship common)
      "admiral-protocol",
      "read-issue",
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
   * Deploy Escort-only skills to a Ship's worktree.
   * Called before Escort launch at gate phase transitions so the Escort
   * has access to gate-specific skills without bloating Ship's context.
   */
  private async deployEscortSkills(
    repoRoot: string,
    worktreePath: string,
    skillSources?: FleetSkillSources,
  ): Promise<void> {
    const admiralSkillsDir = skillSources?.admiralSkillsDir
      ?? join(repoRoot, "skills");

    const escortSkills = [
      // Gate-specific skills (used by Escort for each review phase)
      "planning-gate",
      "implementing-gate",
      "acceptance-test-gate",
      // Unified gate reviewer skill
      "escort",
    ];
    for (const skillName of escortSkills) {
      const src = join(admiralSkillsDir, skillName, "SKILL.md");
      try {
        await this.deploySkill(skillName, src, worktreePath, true);
      } catch {
        console.warn(`[ship-manager] Failed to deploy Escort skill /${skillName}`);
      }
    }
  }

  /**
   * Re-deploy skills to a Ship's worktree before Escort launch.
   * Refreshes Ship skills (force overwrite) and deploys Escort-only
   * skills that were omitted from the initial sortie deployment.
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
    await this.deployEscortSkills(repoRoot, ship.worktreePath, skillSources);
    console.log(`[ship-manager] Re-deployed skills (Ship + Escort) to ${ship.worktreePath}`);
  }

  /**
   * Persist customInstructions to `.claude/rules/custom-instructions.md` in the worktree.
   * Claude Code always reloads `.claude/rules/*.md` on every turn, so this content
   * survives context compaction — unlike `--append-system-prompt` which may be lost.
   * If no customInstructions are provided, remove any stale file from a previous sortie.
   */
  private async deployCustomInstructions(
    worktreePath: string,
    customInstructionsText?: string,
  ): Promise<void> {
    const rulesDir = join(worktreePath, ".claude", "rules");
    const filePath = join(rulesDir, "custom-instructions.md");

    if (!customInstructionsText) {
      // Clean up stale file if it exists
      await unlink(filePath).catch(() => {});
      return;
    }

    await mkdir(rulesDir, { recursive: true });
    await writeFile(filePath, customInstructionsText, "utf-8");
  }

  /**
   * Deploy a rule file documenting the `.claude/` directory write restriction workaround.
   * Claude Code CLI blocks Write/Edit tools for `.claude/` (sensitive directory) even with
   * `--dangerously-skip-permissions`. This rule instructs Ships to use Bash alternatives
   * (`tee`, `cp`, `sed -i`) instead.
   *
   * The rule file is written by the Engine (Node.js fs), not by the Ship itself,
   * so the sensitive directory restriction does not apply here.
   */
  private async deployClaudeDirAccessRule(worktreePath: string): Promise<void> {
    const rulesDir = join(worktreePath, ".claude", "rules");
    const filePath = join(rulesDir, "claude-dir-access.md");

    const content = `# .claude/ Directory Write Restriction

Claude Code CLI blocks Write/Edit tools and shell redirects (\`>\`, \`>>\`) for \`.claude/\` directory paths.
This is a sensitive directory protection that applies even with \`--dangerously-skip-permissions\`.

## Workaround

Use Bash tool with \`tee\`, \`cp\`, \`sed -i\`, or \`mv\` to modify files in \`.claude/\`:

- Write: \`echo 'content' | tee .claude/path/to/file\`
- Copy: \`cp /tmp/draft.md .claude/path/to/file\`
- Edit in-place: \`sed -i '' 's/old/new/g' .claude/path/to/file\`
- Multi-line write: \`cat <<'HEREDOC' | tee .claude/path/to/file\`

Read (via Read tool or \`cat\`) works normally for \`.claude/\` files.

**IMPORTANT**: Never use Write or Edit tools, nor shell redirects (\`>\`, \`>>\`), for any path under \`.claude/\`.
Always use Bash with \`tee\` or \`cp\` instead.
`;

    await mkdir(rulesDir, { recursive: true });
    await writeFile(filePath, content, "utf-8");
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

  /** Base backoff delay (ms) for rate-limited retries. */
  private static readonly RATE_LIMIT_BACKOFF_BASE_MS = 30_000;

  /** Maximum backoff delay (ms) for rate-limited retries. */
  private static readonly RATE_LIMIT_BACKOFF_MAX_MS = 120_000;

  /** Window (ms) within which a rate limit hit triggers backoff on retry. */
  private static readonly RATE_LIMIT_WINDOW_MS = 300_000; // 5 minutes

  /**
   * Compute backoff delay for a rate-limited Ship.
   * Returns 0 if no backoff is needed (no recent rate limit).
   */
  private computeRateLimitBackoff(shipId: string): number {
    const rt = this.runtime.get(shipId);
    if (!rt?.lastRateLimitAt) return 0;

    const elapsed = Date.now() - rt.lastRateLimitAt;
    if (elapsed > ShipManager.RATE_LIMIT_WINDOW_MS) {
      // Rate limit was too long ago — no backoff needed
      rt.lastRateLimitAt = null;
      return 0;
    }

    // Exponential backoff based on rapid death count: 30s, 60s, 120s
    const factor = Math.pow(2, rt.rapidDeathCount);
    return Math.min(
      ShipManager.RATE_LIMIT_BACKOFF_BASE_MS * factor,
      ShipManager.RATE_LIMIT_BACKOFF_MAX_MS,
    );
  }

  /**
   * Retry a dead Ship. If the Ship has a sessionId, resume the session.
   * Otherwise, re-sortie from scratch.
   * Retryable condition: phase !== "done" && process is dead.
   * Returns the resumed/re-launched ShipProcess, or null if not retryable.
   *
   * When a rate limit was recently detected, the actual spawn is delayed
   * with exponential backoff (30s → 60s → 120s) to let the API recover.
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

    const backoffMs = this.computeRateLimitBackoff(shipId);

    const rt = this.ensureRuntime(shipId);
    if (rt) {
      rt.retryCount++;
      rt.processDead = false;
      rt.lastStartedAt = Date.now();
    }

    // Build extra env vars for the Ship process
    const shipEnv: Record<string, string> = {
      VIBE_ADMIRAL_MAIN_REPO: ship.repo,
      VIBE_ADMIRAL_SHIP_ID: shipId,
      VIBE_ADMIRAL_ENGINE_PORT: process.env.ENGINE_PORT ?? "9721",
    };

    // Sync phaseBeforeStopped from DB into Actor context before RESUME,
    // so the RESUME guards have the correct phase to restore to.
    if (ship.phase === "paused") {
      const phaseBeforeStopped = this.fleetDb?.getPhaseBeforeStopped(shipId);
      if (phaseBeforeStopped) {
        this.actorManager?.send(shipId, {
          type: "SET_PHASE_BEFORE_STOPPED",
          phase: phaseBeforeStopped,
        });
      }
    }

    // Send RESUME event to Actor (transitions from paused to previous phase)
    this.actorManager?.send(shipId, { type: "RESUME" });

    // Notify frontend immediately — processDead changed from true to false,
    // but updatePhase() inside doSpawn() won't fire if the phase hasn't changed.
    // This mirrors notifyProcessDead() which notifies without changing the phase.
    this.onPhaseChange?.(shipId, ship.phase, "Ship resumed");

    const doSpawn = () => {
      // Clear rate limit flag after successful backoff wait
      if (backoffMs > 0) {
        const rtNow = this.runtime.get(shipId);
        if (rtNow) {
          rtNow.lastRateLimitAt = null;
          rtNow.lastStartedAt = Date.now();
        }
      }

      if (ship.sessionId) {
        // Resume existing session — re-inject extraPrompt as appendSystemPrompt
        // so customInstructions survive the session resume.
        this.processManager.resumeSession(
          shipId,
          ship.sessionId,
          "The previous session was interrupted. Continue from where you left off.",
          ship.worktreePath,
          shipEnv,
          extraPrompt,
        );
        // For paused ships, restore to the phase before PAUSE.
        // For non-paused ships (process died without formal PAUSE, e.g. rate limit),
        // preserve the current DB phase — do NOT fall back to "coding" which would
        // skip gate phases and cause XState/DB split-brain (#689).
        const previousPhase = ship.phase === "paused"
          ? (this.fleetDb?.getPhaseBeforeStopped(shipId) ?? ship.phase)
          : ship.phase;
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
        this.updatePhase(shipId, "plan", "Re-sortied");
      }
    };

    if (backoffMs > 0) {
      console.log(
        `[ship-manager] Ship #${ship.issueNumber} (${shipId.slice(0, 8)}...) rate limit backoff: ` +
        `waiting ${Math.round(backoffMs / 1000)}s before retry`,
      );
      setTimeout(doSpawn, backoffMs);
    } else {
      doSpawn();
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

    // Mark all escort messages with escort-log metadata for visual distinction (#729)
    for (const msg of escortMsgs) {
      msg.meta = { ...msg.meta, category: "escort-log" };
    }

    // Merge and sort by timestamp, then take the last N messages
    const all = [...shipMsgs, ...escortMsgs];
    all.sort((a, b) => ((a.timestamp as number) ?? 0) - ((b.timestamp as number) ?? 0));

    // If disk had no messages, try loading from DB (worktree may have been deleted)
    if (all.length === 0) {
      return this.loadShipLogsFromDb(shipId, maxLines);
    }

    return all.slice(-maxLines);
  }

  /**
   * Load Ship logs from the database (fallback when worktree is deleted).
   */
  private loadShipLogsFromDb(shipId: string, maxLines: number): StreamMessage[] {
    if (!this.fleetDb) return [];

    const rows = this.fleetDb.getChatLogs(shipId);
    if (rows.length === 0) return [];

    const allMsgs: StreamMessage[] = [];
    for (const row of rows) {
      try {
        const decompressed = gunzipSync(row.data).toString("utf-8");
        const lines = decompressed.trimEnd().split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const parsed = parseStreamMessage(JSON.parse(line));
            if (parsed) {
              if (row.logType === "escort") {
                parsed.meta = { ...parsed.meta, category: "escort-log" };
              }
              allMsgs.push(parsed);
            }
          } catch {
            // Skip malformed lines
          }
        }
      } catch {
        console.warn(`[ship-manager] Failed to decompress chat log for ${shipId} (${row.logType})`);
      }
    }

    allMsgs.sort((a, b) => ((a.timestamp as number) ?? 0) - ((b.timestamp as number) ?? 0));
    return allMsgs.slice(-maxLines);
  }

  /**
   * Persist Ship chat logs (ship-log.jsonl + escort-log.jsonl) to the database.
   * Reads the JSONL files from the worktree, gzip-compresses them, and stores in DB.
   * Called before worktree deletion to ensure logs survive.
   */
  async persistChatLogs(shipId: string): Promise<void> {
    if (!this.fleetDb) return;

    const ship = this.getShip(shipId);
    if (!ship?.worktreePath) return;

    // Skip if already persisted
    if (this.fleetDb.hasChatLogs(shipId)) return;

    const claudeDir = join(ship.worktreePath, ".claude");
    const logFiles: Array<{ path: string; logType: "ship" | "escort" }> = [
      { path: join(claudeDir, "ship-log.jsonl"), logType: "ship" },
      { path: join(claudeDir, "escort-log.jsonl"), logType: "escort" },
    ];

    for (const { path, logType } of logFiles) {
      try {
        const fileStat = await stat(path);
        if (fileStat.size === 0) continue;

        const content = await readFile(path);
        const lineCount = content.toString("utf-8").trimEnd().split("\n").filter(Boolean).length;
        const compressed = gzipSync(content);

        this.fleetDb.saveChatLog(shipId, logType, compressed, lineCount, fileStat.size);
        console.log(
          `[ship-manager] Persisted ${logType} chat log for ${shipId}: ${lineCount} messages, ${fileStat.size} → ${compressed.length} bytes`,
        );
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn(`[ship-manager] Failed to persist ${logType} chat log for ${shipId}:`, err);
        }
      }
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
          lastStartedAt: null,
          rapidDeathCount: 0,
          lastRateLimitAt: null,
        });

        // Restore XState Actor for this Ship (ADR-0017: snapshot-first, replay fallback)
        // For paused Ships, restore phaseBeforeStopped from DB so RESUME guards work
        const phaseBeforeStopped = ship.phase === "paused"
          ? this.fleetDb?.getPhaseBeforeStopped(ship.id) ?? null
          : null;
        const actorSnapshot = this.fleetDb?.getActorSnapshot(ship.id) ?? undefined;
        this.actorManager?.restoreActor(ship, phaseBeforeStopped, actorSnapshot);

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
        lastStartedAt: null,
        rapidDeathCount: 0,
        lastRateLimitAt: null,
      };
      this.runtime.set(shipId, rt);
    }
    return rt;
  }
}
