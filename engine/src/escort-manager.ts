import { randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink, rename, readdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadUnitPrompt } from "./prompt-loader.js";
import type { ProcessManagerLike } from "./process-manager.js";
import type { ShipManager } from "./ship-manager.js";
import type { FleetDatabase } from "./db.js";
import type { ShipActorManager } from "./ship-actor-manager.js";
import type { PhaseTransactionService } from "./phase-transaction-service.js";
import type { EscortProcess, GatePhase, GateType, GateIntent, Phase } from "./types.js";
import { isGatePhase, GATE_PREV_PHASE } from "./types.js";
import { safeJsonParse } from "./util/json-safe.js";

/**
 * On-demand Escort coordination layer using session resume.
 *
 * Escorts are now fully separated from Ships — they have their own
 * `escorts` DB table and do not use ShipManager for persistence.
 * EscortManager owns the full Escort lifecycle: creation, launch,
 * session resume, cleanup, and process exit handling.
 *
 * Lifecycle per gate:
 *   1. Ship enters gate phase (e.g., plan-gate)
 *   2. Engine calls launchEscort(parentShipId, gatePhase, gateType)
 *   3. EscortManager creates or resumes an Escort process
 *   4. Escort reviews, submits verdict, and exits
 *   5. onEscortExit() handles cleanup or phase revert (if no verdict)
 */
/** Directory name for temporarily stashing files during Escort runs. */
const ESCORT_STASH_DIR = ".escort-stash";

/** Rules files that are irrelevant to Escort (Commander-only, Engine-implementer docs). */
const STASH_RULES = ["commander-rules.md", "cli-subprocess.md"];

/** Skills that Escort actually uses — everything else gets stashed.
 *  Names must match the deployed directory names in `.claude/skills/`. */
const ESCORT_SKILLS = new Set([
  "escort-planning-gate",
  "escort-implementing-gate",
  "escort-acceptance-test-gate",
  "shared-read-issue",
]);

/** Map gate phase to the deployed Escort skill name.
 *  The Engine now launches the gate-specific skill directly,
 *  bypassing the deleted `/escort` orchestrator (#896). */
const GATE_PHASE_SKILL: Record<GatePhase, string> = {
  "plan-gate": "/escort-planning-gate",
  "coding-gate": "/escort-implementing-gate",
  "qa-gate": "/escort-acceptance-test-gate",
};

export class EscortManager {
  private processManager: ProcessManagerLike;
  private shipManager: ShipManager;
  private getDatabase: () => FleetDatabase | null;
  private actorManager: ShipActorManager | null = null;
  private phaseTx: PhaseTransactionService | null = null;
  /** parentShipId → escortId mapping (one Escort per parent Ship). */
  private escorts = new Map<string, string>();
  /** parentShipId → Ship's customInstructionsText (for restoring after Escort exits). */
  private shipCustomInstructions = new Map<string, string | undefined>();
  /** parentShipId → pending cleanup promise (stash restore + custom instructions restore). */
  private cleanupPromises = new Map<string, Promise<void>>();
  private onEscortDeathCallback: ((shipId: string, message: string) => void) | null = null;

  constructor(processManager: ProcessManagerLike, shipManager: ShipManager, getDatabase: () => FleetDatabase | null) {
    this.processManager = processManager;
    this.shipManager = shipManager;
    this.getDatabase = getDatabase;
  }

  setActorManager(actorManager: ShipActorManager): void {
    this.actorManager = actorManager;
  }

  setPhaseTransactionService(phaseTx: PhaseTransactionService): void {
    this.phaseTx = phaseTx;
  }

  /** Set callback for Escort death notifications (sent to Flagship). */
  setEscortDeathHandler(handler: (shipId: string, message: string) => void): void {
    this.onEscortDeathCallback = handler;
  }

  /**
   * Store Escort's pre-verdict intent declaration (DB-backed, ADR-0021).
   * Called via gate-intent API before the actual gate-verdict.
   * If the Escort dies before submitting the verdict, this intent
   * is used as a fallback in onEscortExit().
   */
  setGateIntent(parentShipId: string, intent: GateIntent): void {
    const db = this.getDatabase();
    if (db) {
      const feedbackStr = intent.feedback ? (typeof intent.feedback === "string" ? intent.feedback : JSON.stringify(intent.feedback)) : undefined;
      db.setGateIntent(parentShipId, intent.verdict, feedbackStr);
    }
    console.log(
      `[escort-manager] Gate intent declared for Ship ${parentShipId.slice(0, 8)}...: ${intent.verdict}`,
    );
  }

  /** Get stored gate intent for a parent Ship (DB-backed). */
  getGateIntent(parentShipId: string): GateIntent | undefined {
    const db = this.getDatabase();
    if (!db) return undefined;
    const row = db.getGateIntent(parentShipId);
    if (!row) return undefined;
    return {
      verdict: row.verdict,
      feedback: row.feedback ?? undefined,
      declaredAt: row.declaredAt,
    };
  }

  /** Clear stored gate intent (called after verdict is submitted or on cleanup). */
  clearGateIntent(parentShipId: string): void {
    const db = this.getDatabase();
    if (db) db.clearGateIntent(parentShipId);
  }

  /**
   * Launch an Escort on-demand for a specific gate phase.
   *
   * - First gate (no existing Escort): creates a new Escort record and launches fresh
   * - Subsequent gates (existing Escort with sessionId): resumes the previous session
   * - If an Escort process is already running, returns null (duplicate prevention)
   *
   * Returns the escort ID if launched, null if skipped or failed.
   */
  async launchEscort(
    parentShipId: string,
    gatePhase?: GatePhase,
    _gateType?: GateType,
    extraPrompt?: string,
    gatePrompt?: string,
    shipCustomInstructionsText?: string,
    extraEnv?: Record<string, string>,
  ): Promise<string | null> {
    // Wait for any pending cleanup from a previous Escort exit to complete.
    // Without this, stashForEscort() can race with restoreFromEscortStash(),
    // causing mkdir to fail when the stash directory is being removed (#904).
    const pendingCleanup = this.cleanupPromises.get(parentShipId);
    if (pendingCleanup) {
      await pendingCleanup.catch(() => {});
      this.cleanupPromises.delete(parentShipId);
    }

    // Prevent duplicate Escorts for the same parent Ship
    const existingEscortId = this.escorts.get(parentShipId);
    if (existingEscortId && this.processManager.isRunning(existingEscortId)) {
      console.log(
        `[escort-manager] Escort already running for Ship ${parentShipId.slice(0, 8)}... (${existingEscortId.slice(0, 8)}...)`,
      );
      return null;
    }

    const parentShip = this.shipManager.getShip(parentShipId);
    if (!parentShip) {
      console.warn(`[escort-manager] Parent Ship ${parentShipId} not found — cannot launch Escort`);
      return null;
    }

    const db = this.getDatabase();

    // Store Ship's customInstructions for restoration after Escort exits
    this.shipCustomInstructions.set(parentShipId, shipCustomInstructionsText);

    try {
      // Check for an existing Escort record (from a previous gate) with a sessionId
      const existingEscort = db?.getEscortByShipId(parentShipId);

      if (existingEscort?.sessionId) {
        // Try to resume previous Escort session — preserves context from prior gate reviews.
        // If resume fails, fall back to a fresh sortie to break persistent failure loops (#904).
        try {
          const escortId = await this.resumeEscort(existingEscort, parentShip, gatePhase ?? "plan-gate", extraPrompt, gatePrompt, extraEnv);
          this.escorts.set(parentShipId, escortId);

          console.log(
            `[escort-manager] Resumed Escort ${escortId.slice(0, 8)}... (session: ${existingEscort.sessionId.slice(0, 12)}...) for Ship ${parentShipId.slice(0, 8)}... at ${gatePhase ?? "unknown"} gate`,
          );

          return escortId;
        } catch (resumeErr) {
          console.warn(
            `[escort-manager] Resume failed for Escort ${existingEscort.id.slice(0, 8)}... (session: ${existingEscort.sessionId.slice(0, 12)}...) — falling back to fresh sortie. Error:`,
            resumeErr,
          );
          // Clear the stale sessionId so subsequent launches don't keep failing
          db?.updateEscortSessionId(existingEscort.id, null);
        }
      }

      // First gate, no sessionId, or resume failed — launch a fresh Escort
      const escortId = await this.sortieEscort(parentShip, gatePhase, extraPrompt, gatePrompt, extraEnv);
      this.escorts.set(parentShipId, escortId);

      console.log(
        `[escort-manager] Launched new Escort ${escortId.slice(0, 8)}... for Ship ${parentShipId.slice(0, 8)}... at ${gatePhase ?? "unknown"} gate (issue #${parentShip.issueNumber})`,
      );

      return escortId;
    } catch (err) {
      console.error(`[escort-manager] Failed to launch Escort for Ship ${parentShipId.slice(0, 8)}...:`, err);
      return null;
    }
  }

  /**
   * Notify Flagship that an Escort launch failed.
   * Called by api-server when launchEscort() returns null and phase is reverted.
   * Distinct from onEscortExit() death notifications — this covers failures
   * before a process is ever created (e.g., sortie/resume errors, duplicate prevention).
   */
  notifyLaunchFailure(parentShipId: string, gatePhase: GatePhase, reason: string): void {
    const parentShip = this.shipManager.getShip(parentShipId);
    if (!parentShip) return;

    const prevPhase = GATE_PREV_PHASE[gatePhase];
    const message = `Escort launch failed for Ship #${parentShip.issueNumber} (${parentShip.issueTitle}) at ${gatePhase}: ${reason}. Phase reverted to ${prevPhase}.`;
    this.onEscortDeathCallback?.(parentShipId, message);
  }

  /**
   * Launch a fresh Escort for the first gate.
   * Creates a new Escort record in the escorts table and spawns the process.
   */
  private async sortieEscort(
    parentShip: { id: string; repo: string; issueNumber: number; worktreePath: string },
    gatePhase?: GatePhase,
    extraPrompt?: string,
    gatePrompt?: string,
    extraEnv?: Record<string, string>,
  ): Promise<string> {
    const escortId = randomUUID();
    const db = this.getDatabase();

    const escort: EscortProcess = {
      id: escortId,
      shipId: parentShip.id,
      sessionId: null,
      processPid: null,
      phase: "plan",
      createdAt: new Date().toISOString(),
      completedAt: null,
      totalInputTokens: null,
      totalOutputTokens: null,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
      costUsd: null,
    };

    // Persist to escorts table
    if (db) {
      db.upsertEscort(escort);
    }

    // Overwrite .claude/rules/custom-instructions.md with Escort's customInstructions
    // (replaces Ship's instructions that were previously written to this file)
    await this.deployCustomInstructions(parentShip.worktreePath, extraPrompt);

    // Stash Ship-only rules and skills to reduce Escort's initial context
    await this.stashForEscort(parentShip.worktreePath);

    // Launch with the gate-specific skill directly (e.g., /escort-planning-gate).
    // The old `/escort` orchestrator was deleted in #885 and not migrated (#896).
    const escortEnv: Record<string, string> = {
      VIBE_ADMIRAL_MAIN_REPO: parentShip.repo,
      VIBE_ADMIRAL_SHIP_ID: escortId,
      VIBE_ADMIRAL_ENGINE_PORT: process.env.ENGINE_PORT ?? "9721",
      VIBE_ADMIRAL_PARENT_SHIP_ID: parentShip.id,
      ...(gatePrompt ? { VIBE_ADMIRAL_GATE_PROMPT: gatePrompt } : {}),
      ...extraEnv,
    };

    const gateContext = gatePhase
      ? `\n\n${loadUnitPrompt("escort", { gatePhase })}`
      : "";

    const skill = gatePhase ? GATE_PHASE_SKILL[gatePhase] : "/escort-planning-gate";

    this.processManager.sortie(
      escortId,
      parentShip.worktreePath,
      parentShip.issueNumber,
      [extraPrompt, gateContext].filter(Boolean).join("\n\n") || undefined,
      skill,
      escortEnv,
    );

    return escortId;
  }

  /**
   * Resume an existing Escort for a subsequent gate phase.
   * Uses `--resume sessionId` to preserve context from prior gate reviews.
   */
  private async resumeEscort(
    existingEscort: EscortProcess,
    parentShip: { id: string; repo: string; worktreePath: string },
    gatePhase: GatePhase,
    extraPrompt?: string,
    gatePrompt?: string,
    extraEnv?: Record<string, string>,
  ): Promise<string> {
    if (!existingEscort.sessionId) {
      throw new Error(`Cannot resume Escort ${existingEscort.id.slice(0, 8)}... — no sessionId`);
    }

    const escortId = existingEscort.id;

    // Overwrite .claude/rules/custom-instructions.md with Escort's customInstructions
    await this.deployCustomInstructions(parentShip.worktreePath, extraPrompt);

    // Stash Ship-only rules and skills to reduce Escort's initial context
    await this.stashForEscort(parentShip.worktreePath);

    // Build Escort env vars
    const escortEnv: Record<string, string> = {
      VIBE_ADMIRAL_MAIN_REPO: parentShip.repo,
      VIBE_ADMIRAL_SHIP_ID: escortId,
      VIBE_ADMIRAL_ENGINE_PORT: process.env.ENGINE_PORT ?? "9721",
      VIBE_ADMIRAL_PARENT_SHIP_ID: parentShip.id,
      ...(gatePrompt ? { VIBE_ADMIRAL_GATE_PROMPT: gatePrompt } : {}),
      ...extraEnv,
    };

    // Resume with gate context message
    const resumeMessage = `The parent Ship has entered ${gatePhase}. Execute the ${gatePhase} review, submit the verdict, and exit.`;

    this.processManager.resumeSession(
      escortId,
      existingEscort.sessionId,
      resumeMessage,
      parentShip.worktreePath,
      escortEnv,
      extraPrompt,
      "escort-log.jsonl",
    );

    return escortId;
  }

  /**
   * Persist customInstructions to `.claude/rules/custom-instructions.md` in the worktree.
   * Mirrors ShipManager.deployCustomInstructions() — overwrites with Escort-specific
   * instructions before launch, and restores Ship's instructions after Escort exits.
   */
  private async deployCustomInstructions(
    worktreePath: string,
    customInstructionsText?: string,
  ): Promise<void> {
    const rulesDir = join(worktreePath, ".claude", "rules");
    const filePath = join(rulesDir, "custom-instructions.md");

    if (!customInstructionsText) {
      return;
    }

    await mkdir(rulesDir, { recursive: true });
    await writeFile(filePath, customInstructionsText, "utf-8");
  }

  /**
   * Restore Ship's customInstructions to `.claude/rules/custom-instructions.md`.
   * Called after Escort exits so the Ship resumes with its own instructions.
   */
  private async restoreShipCustomInstructions(parentShipId: string): Promise<void> {
    const parentShip = this.shipManager.getShip(parentShipId);
    if (!parentShip) return;

    const shipCi = this.shipCustomInstructions.get(parentShipId);
    const rulesDir = join(parentShip.worktreePath, ".claude", "rules");
    const filePath = join(rulesDir, "custom-instructions.md");

    if (shipCi) {
      await mkdir(rulesDir, { recursive: true });
      await writeFile(filePath, shipCi, "utf-8");
    } else {
      // No Ship CI — remove Escort's file to avoid contamination
      await unlink(filePath).catch(() => {});
    }

    this.shipCustomInstructions.delete(parentShipId);
  }

  /**
   * Stash rules and skills that are irrelevant to Escort.
   * Moves them to `.claude/.escort-stash/` so they don't bloat Escort's context.
   * Called before Escort launch; restored by restoreFromEscortStash() after exit.
   */
  private async stashForEscort(worktreePath: string): Promise<void> {
    const claudeDir = join(worktreePath, ".claude");
    const stashBase = join(claudeDir, ESCORT_STASH_DIR);
    const stashRulesDir = join(stashBase, "rules");
    const stashSkillsDir = join(stashBase, "skills");

    try {
      await mkdir(stashRulesDir, { recursive: true });
      await mkdir(stashSkillsDir, { recursive: true });
    } catch (mkdirErr) {
      // Race with restoreFromEscortStash's rm() can cause ENOENT — retry once (#904)
      console.warn(`[escort-manager] stashForEscort mkdir failed, retrying:`, mkdirErr);
      await mkdir(stashRulesDir, { recursive: true });
      await mkdir(stashSkillsDir, { recursive: true });
    }

    // Stash irrelevant rules
    const rulesDir = join(claudeDir, "rules");
    for (const ruleName of STASH_RULES) {
      const src = join(rulesDir, ruleName);
      const dest = join(stashRulesDir, ruleName);
      await rename(src, dest).catch(() => {});
    }

    // Stash CLAUDE.md from worktree root (not under .claude/)
    const claudeMdSrc = join(worktreePath, "CLAUDE.md");
    const claudeMdDest = join(stashBase, "CLAUDE.md");
    await rename(claudeMdSrc, claudeMdDest).catch(() => {});

    // Stash Ship-only skills (everything not in ESCORT_SKILLS)
    const skillsDir = join(claudeDir, "skills");
    let entries: string[];
    try {
      entries = await readdir(skillsDir);
    } catch {
      return; // No skills directory
    }
    for (const entry of entries) {
      if (ESCORT_SKILLS.has(entry)) continue;
      const src = join(skillsDir, entry);
      const dest = join(stashSkillsDir, entry);
      await rename(src, dest).catch(() => {});
    }

    console.log(`[escort-manager] Stashed CLAUDE.md + Ship rules/skills to ${ESCORT_STASH_DIR}`);
  }

  /**
   * Restore stashed rules and skills after Escort exits.
   * Moves files from `.claude/.escort-stash/` back to their original locations.
   */
  private async restoreFromEscortStash(worktreePath: string): Promise<void> {
    const claudeDir = join(worktreePath, ".claude");
    const stashBase = join(claudeDir, ESCORT_STASH_DIR);

    // Restore rules
    const stashRulesDir = join(stashBase, "rules");
    const rulesDir = join(claudeDir, "rules");
    try {
      const entries = await readdir(stashRulesDir);
      for (const entry of entries) {
        await rename(join(stashRulesDir, entry), join(rulesDir, entry)).catch(() => {});
      }
    } catch {
      // No stashed rules
    }

    // Restore skills
    const stashSkillsDir = join(stashBase, "skills");
    const skillsDir = join(claudeDir, "skills");
    try {
      const entries = await readdir(stashSkillsDir);
      for (const entry of entries) {
        await rename(join(stashSkillsDir, entry), join(skillsDir, entry)).catch(() => {});
      }
    } catch {
      // No stashed skills
    }

    // Restore CLAUDE.md to worktree root
    const claudeMdStash = join(stashBase, "CLAUDE.md");
    const claudeMdDest = join(worktreePath, "CLAUDE.md");
    await rename(claudeMdStash, claudeMdDest).catch(() => {});

    // Remove stash directory
    await rm(stashBase, { recursive: true, force: true }).catch(() => {});

    console.log(`[escort-manager] Restored CLAUDE.md + Ship rules/skills from ${ESCORT_STASH_DIR}`);
  }

  /** Check if an Escort process is currently running for a parent Ship. */
  isEscortRunning(parentShipId: string): boolean {
    const escortId = this.escorts.get(parentShipId);
    if (!escortId) {
      // Check DB for restored Escorts (after Engine restart)
      const db = this.getDatabase();
      const escort = db?.getEscortByShipId(parentShipId);
      if (escort) {
        this.escorts.set(parentShipId, escort.id);
        return this.processManager.isRunning(escort.id);
      }
      return false;
    }
    return this.processManager.isRunning(escortId);
  }

  /** Kill the Escort for a parent Ship. */
  killEscort(parentShipId: string): boolean {
    const escortId = this.escorts.get(parentShipId);
    if (!escortId) return false;
    const killed = this.processManager.kill(escortId);
    this.escorts.delete(parentShipId);
    return killed;
  }

  /**
   * Clean up the Escort when the parent Ship reaches "done".
   * 1. Resolve Escort ID (in-memory map, then DB fallback)
   * 2. Kill the Escort process
   * 3. Mark the Escort's DB record as done
   */
  cleanupForDoneShip(parentShipId: string): void {
    const db = this.getDatabase();

    // Resolve Escort ID: prefer in-memory map, fall back to DB
    let escortId = this.escorts.get(parentShipId);
    if (!escortId) {
      const escort = db?.getEscortByShipId(parentShipId);
      if (escort) {
        escortId = escort.id;
      }
    }
    if (!escortId) return;

    // Kill Escort process (idempotent if already dead)
    this.processManager.kill(escortId);
    this.escorts.delete(parentShipId);

    // Mark Escort DB record as done
    db?.updateEscortPhase(escortId, "done", new Date().toISOString());

    console.log(
      `[escort-manager] Cleaned up Escort ${escortId.slice(0, 8)}... for done Ship ${parentShipId.slice(0, 8)}...`,
    );
  }

  /** Check if a process ID belongs to an Escort. */
  isEscortProcess(processId: string): boolean {
    // Check in-memory map
    for (const escortId of this.escorts.values()) {
      if (escortId === processId) return true;
    }
    // Check DB
    const db = this.getDatabase();
    const escort = db?.getEscortById(processId);
    return escort !== undefined;
  }

  /** Find the parent Ship ID for an Escort process ID. */
  findShipIdByEscortId(escortShipId: string): string | undefined {
    for (const [parentId, escortId] of this.escorts) {
      if (escortId === escortShipId) return parentId;
    }
    // Fallback: check DB
    const db = this.getDatabase();
    const escort = db?.getEscortById(escortShipId);
    if (escort) {
      this.escorts.set(escort.shipId, escortShipId);
      return escort.shipId;
    }
    return undefined;
  }

  /** Update an Escort's session ID in the DB. */
  setEscortSessionId(escortId: string, sessionId: string): void {
    const db = this.getDatabase();
    db?.updateEscortSessionId(escortId, sessionId);
  }

  /**
   * Handle Escort process exit.
   *
   * In the on-demand model, Escort exit is expected after each gate review
   * (verdict submitted → process exits normally). We only treat it as an error
   * if the parent Ship is still in a gate phase (verdict not submitted).
   */
  onEscortExit(escortShipId: string, code: number | null): void {
    const parentShipId = this.findShipIdByEscortId(escortShipId);
    if (!parentShipId) return;

    // Restore stashed rules/skills and Ship's customInstructions.
    // Track the cleanup as a promise so launchEscort() can await it
    // before starting a new Escort — prevents stash/restore race (#904).
    {
      const ship = this.shipManager.getShip(parentShipId);
      const cleanupPromise = (async () => {
        if (ship) {
          await this.restoreFromEscortStash(ship.worktreePath).catch((err) => {
            console.warn(`[escort-manager] Failed to restore stashed files for ${parentShipId.slice(0, 8)}...:`, err);
          });
        }
        await this.restoreShipCustomInstructions(parentShipId).catch((err) => {
          console.warn(`[escort-manager] Failed to restore Ship customInstructions for ${parentShipId.slice(0, 8)}...:`, err);
        });
      })();
      this.cleanupPromises.set(parentShipId, cleanupPromise);
    }

    // Remove from active process tracking (but preserve DB record for session resume)
    this.escorts.delete(parentShipId);

    console.log(
      `[escort-manager] Escort ${escortShipId.slice(0, 8)}... exited (code=${code}) for parent Ship ${parentShipId.slice(0, 8)}...`,
    );

    const db = this.getDatabase();
    if (!db) return;

    const parentShip = db.getShipById(parentShipId);
    if (!parentShip) return;

    const currentPhase = parentShip.phase as Phase;
    if (!isGatePhase(currentPhase)) {
      // Phase already moved past gate — verdict was submitted successfully.
      // This is the normal path in the on-demand model.
      this.shipManager.clearGateCheck(parentShipId);
      this.clearGateIntent(parentShipId);
      return;
    }

    // Escort died without submitting verdict while parent is in gate phase.
    // Log diagnostic info from escort-log.jsonl to aid debugging (#896).
    {
      const ship = this.shipManager.getShip(parentShipId);
      if (ship) {
        const logPath = join(ship.worktreePath, ".claude", "escort-log.jsonl");
        readFile(logPath, "utf-8").then((content) => {
          const lines = content.trim().split("\n").slice(-10);
          const lastMessages = lines
            .map((l) => safeJsonParse<Record<string, unknown>>(l, { source: "escort.lastLog" }))
            .filter((m): m is Record<string, unknown> => m != null)
            .filter((m) => m.type === "assistant" || m.type === "result")
            .map((m) => {
              if (m.type === "result") return `[result] costUsd=${m.costUsd as number | undefined}`;
              return `[assistant] ${(String(m.message ?? "")).slice(0, 200)}`;
            });
          if (lastMessages.length > 0) {
            console.warn(
              `[escort-manager] Escort ${escortShipId.slice(0, 8)}... last log entries:\n${lastMessages.join("\n")}`,
            );
          }
        }).catch(() => { /* log file may not exist */ });
      }
    }

    // Check for a pre-declared gate intent — if the Escort declared "approve"
    // before dying, honour that intent instead of reverting (fallback mechanism).
    const intent = this.getGateIntent(parentShipId);
    this.clearGateIntent(parentShipId);

    if (intent?.verdict === "approve" && this.phaseTx) {
      console.log(
        `[escort-manager] Escort ${escortShipId.slice(0, 8)}... died without verdict, but gate-intent was "approve" — auto-approving for Ship ${parentShipId.slice(0, 8)}...`,
      );

      const approveResult = this.phaseTx.commit(parentShipId, {
        event: { type: "GATE_APPROVED" },
        triggeredBy: "escort",
        metadata: {
          gate_result: "approved",
          fallback: true,
          reason: `Escort died (code=${code}) but had declared approve intent — auto-approved`,
        },
      });

      if (approveResult.success) {
        return;
      }
      console.warn(
        `[escort-manager] Fallback GATE_APPROVED failed for Ship ${parentShipId.slice(0, 8)}...: ${approveResult.error} — falling through to revert`,
      );
    }

    // No approve intent or fallback failed — treat as rejection
    const prevPhase = GATE_PREV_PHASE[currentPhase as GatePhase];
    console.warn(
      `[escort-manager] Escort ${escortShipId.slice(0, 8)}... died without verdict — reverting Ship ${parentShipId.slice(0, 8)}... from ${currentPhase} to ${prevPhase}`,
    );

    const feedback = `Escort process exited unexpectedly (code=${code}) without submitting verdict`;
    if (this.phaseTx) {
      const result = this.phaseTx.commit(parentShipId, {
        event: { type: "ESCORT_DIED", exitCode: code, feedback },
        triggeredBy: "escort",
        metadata: { gate_result: "rejected", feedback },
      });
      if (!result.success) {
        console.error(`[escort-manager] Phase revert failed for Ship ${parentShipId.slice(0, 8)}...: ${result.error}`);
      }
    }

    // Check if Escort fail count has exceeded the limit — auto-stop the Ship
    const MAX_ESCORT_FAILS = 3;
    const context = this.actorManager?.getContext(parentShipId);
    if (context && context.escortFailCount >= MAX_ESCORT_FAILS) {
      console.error(
        `[escort-manager] Ship #${parentShip.issueNumber} (${parentShipId.slice(0, 8)}...) hit Escort fail limit ` +
        `(${context.escortFailCount}/${MAX_ESCORT_FAILS} consecutive failures) — auto-stopping to prevent infinite loop`,
      );
      this.actorManager?.send(parentShipId, { type: "PAUSE" });
      this.actorManager?.send(parentShipId, { type: "ESCORT_FAIL_LIMIT" });
      this.shipManager.updatePhase(parentShipId, "paused", `Auto-paused: ${MAX_ESCORT_FAILS} consecutive Escort failures in ${currentPhase}`);

      const stopMessage = `Ship #${parentShip.issueNumber} (${parentShip.issueTitle}) auto-paused: ${MAX_ESCORT_FAILS} consecutive Escort failures in ${currentPhase}. Manual intervention required.`;
      this.onEscortDeathCallback?.(parentShipId, stopMessage);
      return;
    }

    // Notify Flagship
    const message = `Escort died without verdict for Ship #${parentShip.issueNumber} (${parentShip.issueTitle}) during ${currentPhase}. Phase reverted to ${prevPhase}. (exit code=${code})`;
    this.onEscortDeathCallback?.(parentShipId, message);
  }

  /** Kill all running Escort processes. */
  killAll(): void {
    for (const [parentShipId, escortId] of this.escorts) {
      this.processManager.kill(escortId);
      this.escorts.delete(parentShipId);
    }
  }
}
