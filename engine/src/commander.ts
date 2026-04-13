import { appendFile, readFile, readdir, writeFile, mkdir, stat, rename, copyFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessManagerLike } from "./process-manager.js";
import { getAdmiralHome } from "./admiral-home.js";
import type { StreamMessage, PersistedCommanderSession, CommanderRole, Dispatch, DispatchStatus } from "./types.js";
import { UNIT_DEPLOY_MAP } from "./unit-deploy-map.js";
import { safeJsonParse } from "./util/json-safe.js";
import { buildCommanderEnv, toLaunchRecord } from "./launch-environment.js";
import { validateOrFresh } from "./session-resumer.js";
import type { ContextRegistry } from "./context-registry.js";

const MAX_HISTORY = 500;

export interface CommanderSession {
  id: string;
  role: CommanderRole;
  fleetId: string;
  fleetPath: string;
  additionalDirs: string[];
  systemPrompt?: string;
  sessionId: string | null;
  history: StreamMessage[];
  /** Tool use ID of a pending AskUserQuestion (null when no question pending). */
  pendingToolUseId: string | null;
  /** Timestamp (ms epoch) when AskUserQuestion was received (null when no question pending). */
  questionAskedAt: number | null;
  /** Active and completed Dispatch sub-agents, keyed by toolUseId. */
  dispatches: Map<string, Dispatch>;
  /** Files deployed to Fleet repo that should be cleaned up on stop. */
  deployedFiles: string[];
}

/**
 * Shared session lifecycle manager for Dock and Flagship.
 * Both roles use the same Claude CLI interactive session model,
 * differing only in system prompt, skills, and request routing.
 */
export class CommanderManager {
  private sessions = new Map<string, CommanderSession>();
  protected processManager: ProcessManagerLike;
  private appendCount = 0;
  protected readonly role: CommanderRole;
  private contextRegistry: ContextRegistry | null = null;

  constructor(processManager: ProcessManagerLike, role: CommanderRole) {
    this.processManager = processManager;
    this.role = role;
  }

  setContextRegistry(registry: ContextRegistry): void {
    this.contextRegistry = registry;
  }

  /**
   * Launch a new commander session. If a persisted session exists with a valid
   * sessionId, attempt to resume the Claude CLI session.
   *
   * @param admiralUnitsDir - Absolute path to vibe-admiral's units/ directory.
   *   When provided, skills/rules are deployed FROM this directory TO fleetPath/.claude/.
   * @param customInstructionsText - Fleet's custom instructions text (shared + role-specific).
   *   Deployed to fleetPath/.claude/rules/custom-instructions.md so it persists across
   *   context compaction and correctly overrides any repo-level custom-instructions.md.
   */
  async launch(
    fleetId: string,
    fleetPath: string,
    additionalDirs: string[],
    systemPrompt?: string,
    admiralUnitsDir?: string,
    customInstructionsText?: string,
  ): Promise<string> {
    const sessionId = `${this.role}-${fleetId}`;

    // Load persisted history and session info
    const restoredHistory = await this.loadHistory(fleetId);
    const persisted = await this.loadSession(fleetId);

    // ADR-0024: Unified cwd/session validation via SessionResumer
    const resumeResult = validateOrFresh(persisted?.sessionId ?? null, {
      expectedCwd: fleetPath,
      persistedCwd: persisted?.cwd,
    });

    // Deploy skills, rules, and custom instructions to Fleet repo
    const deployedFiles: string[] = [];
    await this.deploySkills(fleetPath, deployedFiles, admiralUnitsDir);
    await this.deployRules(fleetPath, deployedFiles, admiralUnitsDir, customInstructionsText);

    const session: CommanderSession = {
      id: sessionId,
      role: this.role,
      fleetId,
      fleetPath,
      additionalDirs,
      systemPrompt,
      sessionId: resumeResult.sessionId,
      history: restoredHistory,
      pendingToolUseId: null,
      questionAskedAt: null,
      dispatches: new Map(),
      deployedFiles,
    };
    this.sessions.set(fleetId, session);

    // ADR-0024: Type-safe env assembly via LaunchEnvironment
    const commanderEnv = buildCommanderEnv({ fleetId });

    this.contextRegistry?.register({
      fleetId,
      unitKind: "commander",
      unitId: sessionId,
      cwd: fleetPath,
      sessionId: resumeResult.sessionId,
      customInstructionsSource: customInstructionsText ? "fleet" : "global",
      customInstructionsHash: "",
    });

    if (session.sessionId) {
      this.processManager.resumeCommander(
        sessionId,
        session.sessionId,
        fleetPath,
        additionalDirs,
        systemPrompt,
        toLaunchRecord(commanderEnv),
      );
    } else {
      this.processManager.launchCommander(
        sessionId,
        fleetPath,
        additionalDirs,
        systemPrompt,
        toLaunchRecord(commanderEnv),
      );
    }
    return sessionId;
  }

  hasSession(fleetId: string): boolean {
    return this.sessions.has(fleetId);
  }

  /**
   * Check if the Commander process for this fleet is dead, and re-launch it if so.
   * Returns { resumed: true, method } if re-launched, { resumed: false, reason } if skipped.
   */
  resumeIfDead(fleetId: string): { resumed: boolean; method?: string; reason?: string } {
    const session = this.sessions.get(fleetId);
    if (!session) {
      return { resumed: false, reason: "no session" };
    }

    const processId = `${this.role}-${fleetId}`;
    if (this.processManager.isRunning(processId)) {
      return { resumed: false, reason: "already running" };
    }

    // ADR-0024: Type-safe env assembly via LaunchEnvironment
    const commanderEnv = buildCommanderEnv({ fleetId });

    if (session.sessionId) {
      this.processManager.resumeCommander(
        processId,
        session.sessionId,
        session.fleetPath,
        session.additionalDirs,
        session.systemPrompt,
        toLaunchRecord(commanderEnv),
      );
      return { resumed: true, method: "session resume" };
    } else {
      this.processManager.launchCommander(
        processId,
        session.fleetPath,
        session.additionalDirs,
        session.systemPrompt,
        toLaunchRecord(commanderEnv),
      );
      return { resumed: true, method: "fresh launch" };
    }
  }

  setSessionId(fleetId: string, sessionId: string): void {
    const session = this.sessions.get(fleetId);
    if (session && !session.sessionId) {
      session.sessionId = sessionId;
      this.persistSession(fleetId, sessionId, session.fleetPath);
    }
  }

  /**
   * Clear sessionId so next launch/resumeIfDead creates a fresh session.
   * Called when --resume fails (e.g. exit code 1 due to cwd mismatch).
   */
  clearSessionId(fleetId: string): void {
    const session = this.sessions.get(fleetId);
    if (session) {
      session.sessionId = null;
    }
    // Also clear persisted session file
    const filePath = this.sessionPath(fleetId);
    writeFile(filePath, JSON.stringify({ fleetId, role: this.role, sessionId: null, createdAt: new Date().toISOString() }, null, 2))
      .catch(() => {});
  }

  send(
    fleetId: string,
    message: string,
    images?: Array<{ base64: string; mediaType: string }>,
  ): boolean {
    const session = this.sessions.get(fleetId);
    if (!session) return false;

    const processId = `${this.role}-${fleetId}`;

    // Store user message in history (include image count, not full data, to limit memory)
    const historyEntry: StreamMessage = { type: "user", content: message };
    if (images && images.length > 0) {
      historyEntry.imageCount = images.length;
    }
    this.addToHistory(fleetId, historyEntry);

    // If process died, re-launch it
    if (!this.processManager.isRunning(processId)) {
      const commanderEnv = { VIBE_ADMIRAL_FLEET_ID: fleetId };
      if (session.sessionId) {
        this.processManager.resumeCommander(
          processId,
          session.sessionId,
          session.fleetPath,
          session.additionalDirs,
          session.systemPrompt,
          commanderEnv,
        );
      } else {
        this.processManager.launchCommander(
          processId,
          session.fleetPath,
          session.additionalDirs,
          session.systemPrompt,
          commanderEnv,
        );
      }
    }

    const sendResult = this.processManager.sendMessage(processId, message, images);
    if (!sendResult.ok) {
      console.warn(`[${this.role}] sendMessage failed for fleet ${fleetId}: ${sendResult.reason}`);
      return false;
    }
    return true;
  }

  addToHistory(fleetId: string, message: StreamMessage): void {
    const session = this.sessions.get(fleetId);
    if (session) {
      session.history.push(message);
      if (session.history.length > MAX_HISTORY) {
        session.history = session.history.slice(-MAX_HISTORY);
      }
      this.persistHistoryEntry(fleetId, message);
    }
  }

  getHistory(fleetId: string): StreamMessage[] {
    return this.sessions.get(fleetId)?.history ?? [];
  }

  /**
   * Load history from disk when no in-memory session exists.
   * Used to serve history requests after Engine restart (before
   * the Commander process is re-launched by a user message).
   */
  async getHistoryWithDiskFallback(fleetId: string): Promise<StreamMessage[]> {
    const inMemory = this.sessions.get(fleetId)?.history;
    if (inMemory && inMemory.length > 0) return inMemory;
    return this.loadHistory(fleetId);
  }

  setPendingQuestion(fleetId: string, toolUseId: string): void {
    const session = this.sessions.get(fleetId);
    if (session) {
      session.pendingToolUseId = toolUseId;
      session.questionAskedAt = Date.now();
    }
  }

  clearPendingQuestion(fleetId: string): void {
    const session = this.sessions.get(fleetId);
    if (session) {
      session.pendingToolUseId = null;
      session.questionAskedAt = null;
    }
  }

  getPendingQuestion(fleetId: string): { toolUseId: string; askedAt: number } | null {
    const session = this.sessions.get(fleetId);
    if (session?.pendingToolUseId && session.questionAskedAt) {
      return { toolUseId: session.pendingToolUseId, askedAt: session.questionAskedAt };
    }
    return null;
  }

  /** Return all sessions that have a pending question. */
  getSessionsWithPendingQuestion(): Array<{ fleetId: string; toolUseId: string; askedAt: number }> {
    const results: Array<{ fleetId: string; toolUseId: string; askedAt: number }> = [];
    for (const [fleetId, session] of this.sessions) {
      if (session.pendingToolUseId && session.questionAskedAt) {
        results.push({ fleetId, toolUseId: session.pendingToolUseId, askedAt: session.questionAskedAt });
      }
    }
    return results;
  }

  // --- Dispatch tracking ---

  /** Register a new Dispatch when an Agent tool_use is detected. */
  registerDispatch(fleetId: string, toolUseId: string, name: string): Dispatch | null {
    const session = this.sessions.get(fleetId);
    if (!session) return null;
    const dispatch: Dispatch = {
      id: toolUseId,
      parentRole: this.role,
      fleetId,
      name,
      status: "running",
      startedAt: Date.now(),
      parentSessionId: `${this.role}-${fleetId}`,
    };
    session.dispatches.set(toolUseId, dispatch);
    return dispatch;
  }

  /** Update a Dispatch status (e.g. on task_notification). */
  updateDispatchStatus(fleetId: string, dispatchId: string, status: DispatchStatus, result?: string): Dispatch | null {
    const session = this.sessions.get(fleetId);
    if (!session) return null;
    const dispatch = session.dispatches.get(dispatchId);
    if (!dispatch) return null;
    dispatch.status = status;
    if (status === "completed" || status === "failed") {
      dispatch.completedAt = Date.now();
    }
    if (result !== undefined) {
      dispatch.result = result;
    }
    return dispatch;
  }

  /** Complete the most recent running Dispatch for a fleet. */
  completeLatestDispatch(fleetId: string, status: DispatchStatus, result?: string): Dispatch | null {
    const session = this.sessions.get(fleetId);
    if (!session) return null;
    // Find the most recently started running dispatch
    let latest: Dispatch | null = null;
    for (const d of session.dispatches.values()) {
      if (d.status === "running") {
        if (!latest || d.startedAt > latest.startedAt) {
          latest = d;
        }
      }
    }
    if (!latest) return null;
    return this.updateDispatchStatus(fleetId, latest.id, status, result);
  }

  /** Get all dispatches for a fleet. */
  getDispatches(fleetId: string): Dispatch[] {
    const session = this.sessions.get(fleetId);
    if (!session) return [];
    return Array.from(session.dispatches.values());
  }

  async stop(fleetId: string): Promise<void> {
    const session = this.sessions.get(fleetId);
    const processId = `${this.role}-${fleetId}`;
    this.processManager.kill(processId);

    // Clean up deployed files from Fleet repo
    if (session?.deployedFiles) {
      for (const filePath of session.deployedFiles) {
        await unlink(filePath).catch(() => {});
      }
    }

    this.sessions.delete(fleetId);
  }

  async stopAll(): Promise<void> {
    for (const [fleetId] of this.sessions) {
      await this.stop(fleetId);
    }
  }

  /** Get the process ID prefix for this commander role. */
  getProcessIdPrefix(): string {
    return `${this.role}-`;
  }

  /** Get the process ID for a fleet. */
  getProcessId(fleetId: string): string {
    return `${this.role}-${fleetId}`;
  }

  /**
   * Deploy role-specific skills to fleetPath/.claude/skills/.
   * Sources skills from units/<role>/skills/ and units/shared/skills/
   * based on UNIT_DEPLOY_MAP. Deploy destination uses <unit>-<name> prefix.
   */
  protected async deploySkills(
    fleetPath: string,
    deployedFiles: string[],
    admiralUnitsDir?: string,
  ): Promise<void> {
    if (!admiralUnitsDir) return;

    const map = UNIT_DEPLOY_MAP[this.role as keyof typeof UNIT_DEPLOY_MAP];
    if (!map) return;

    // Deploy unit-specific skills: units/<role>/skills/<name>/
    for (const skillName of map.skills) {
      const src = join(admiralUnitsDir, this.role, "skills", skillName, "SKILL.md");
      const deployName = `${this.role}-${skillName}`;
      const dest = join(fleetPath, ".claude", "skills", deployName, "SKILL.md");
      try {
        await mkdir(join(fleetPath, ".claude", "skills", deployName), { recursive: true });
        await copyFile(src, dest);
        deployedFiles.push(dest);
      } catch {
        // Non-fatal: skill may not exist
      }
    }

    // Deploy shared skills: units/shared/skills/<name>/
    for (const skillName of map.sharedSkills) {
      const src = join(admiralUnitsDir, "shared", "skills", skillName, "SKILL.md");
      const deployName = `shared-${skillName}`;
      const dest = join(fleetPath, ".claude", "skills", deployName, "SKILL.md");
      try {
        await mkdir(join(fleetPath, ".claude", "skills", deployName), { recursive: true });
        await copyFile(src, dest);
        deployedFiles.push(dest);
      } catch {
        // Non-fatal: skill may not exist
      }
    }
  }

  /**
   * Deploy rules from units/<role>/rules/ and units/shared/rules/ to fleetPath/.claude/rules/.
   * Also deploys Fleet custom instructions as custom-instructions.md.
   */
  protected async deployRules(
    fleetPath: string,
    deployedFiles: string[],
    admiralUnitsDir?: string,
    customInstructionsText?: string,
  ): Promise<void> {
    if (!admiralUnitsDir && !customInstructionsText) return;

    const destDir = join(fleetPath, ".claude", "rules");
    await mkdir(destDir, { recursive: true });

    if (admiralUnitsDir) {
      // Deploy unit-specific rules: units/<role>/rules/*.md
      const unitRulesDir = join(admiralUnitsDir, this.role, "rules");
      await this.copyRulesFromDir(unitRulesDir, destDir, deployedFiles);

      // Deploy shared rules: units/shared/rules/*.md
      const sharedRulesDir = join(admiralUnitsDir, "shared", "rules");
      await this.copyRulesFromDir(sharedRulesDir, destDir, deployedFiles);
    }

    // Deploy Fleet custom instructions as custom-instructions.md
    if (customInstructionsText) {
      const dest = join(destDir, "custom-instructions.md");
      await writeFile(dest, `## Custom Instructions\n\n${customInstructionsText}`, "utf-8");
      deployedFiles.push(dest);
    }
  }

  /** Copy all .md files from a rules directory to the destination. */
  private async copyRulesFromDir(
    srcDir: string,
    destDir: string,
    deployedFiles: string[],
  ): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(srcDir);
    } catch {
      return; // Directory doesn't exist — skip
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const src = join(srcDir, entry);
      const dest = join(destDir, entry);
      try {
        await copyFile(src, dest);
        deployedFiles.push(dest);
      } catch {
        console.warn(`[${this.role}] Failed to deploy rule ${entry}`);
      }
    }
  }

  // --- Disk persistence ---

  private fleetDir(fleetId: string): string {
    return join(getAdmiralHome(), fleetId);
  }

  private historyPath(fleetId: string): string {
    return join(this.fleetDir(fleetId), `${this.role}-history.jsonl`);
  }

  private sessionPath(fleetId: string): string {
    return join(this.fleetDir(fleetId), `${this.role}-session.json`);
  }

  /** Append a single message to the JSONL history file. Fire-and-forget. */
  private persistHistoryEntry(fleetId: string, message: StreamMessage): void {
    const dir = this.fleetDir(fleetId);
    const filePath = this.historyPath(fleetId);
    const line = JSON.stringify(message) + "\n";
    this.appendCount++;
    mkdir(dir, { recursive: true })
      .then(() => appendFile(filePath, line))
      .then(async () => {
        // Rotate periodically using file size as proxy (avoid reading every time)
        if (this.appendCount % 100 !== 0) return;
        const s = await stat(filePath).catch(() => null);
        if (!s || s.size < MAX_HISTORY * 200) return;
        const content = await readFile(filePath, "utf-8");
        const lines = content.trimEnd().split("\n");
        if (lines.length > MAX_HISTORY * 2) {
          const tmpPath = filePath + ".tmp";
          const trimmed = lines.slice(-MAX_HISTORY).join("\n") + "\n";
          await writeFile(tmpPath, trimmed);
          await rename(tmpPath, filePath);
        }
      })
      .catch((err) => {
        console.warn(`[${this.role}] Failed to persist history entry:`, err);
      });
  }

  /** Load history from JSONL file. Falls back to legacy bridge-history.jsonl. */
  private async loadHistory(fleetId: string): Promise<StreamMessage[]> {
    const filePath = this.historyPath(fleetId);
    let content: string | null = null;

    try {
      await stat(filePath);
      content = await readFile(filePath, "utf-8");
    } catch {
      // Try legacy bridge-history.jsonl for migration
      if (this.role === "flagship") {
        try {
          const legacyPath = join(this.fleetDir(fleetId), "bridge-history.jsonl");
          await stat(legacyPath);
          content = await readFile(legacyPath, "utf-8");
        } catch {
          // No legacy file either
        }
      }
    }

    if (!content) return [];

    const lines = content.trimEnd().split("\n").filter(Boolean);
    const messages: StreamMessage[] = [];
    for (const line of lines) {
      const msg = safeJsonParse<StreamMessage>(line, { source: "commander.history" });
      if (msg) messages.push(msg);
    }
    return messages.slice(-MAX_HISTORY);
  }

  /** Persist session metadata (sessionId) to disk. Fire-and-forget. */
  private persistSession(fleetId: string, sessionId: string, cwd: string): void {
    const dir = this.fleetDir(fleetId);
    const filePath = this.sessionPath(fleetId);
    const data: PersistedCommanderSession = {
      fleetId,
      role: this.role,
      sessionId,
      createdAt: new Date().toISOString(),
      cwd,
    };
    mkdir(dir, { recursive: true })
      .then(() => writeFile(filePath, JSON.stringify(data, null, 2)))
      .catch((err) => {
        console.warn(`[${this.role}] Failed to persist session:`, err);
      });
  }

  /** Load persisted session metadata. Falls back to legacy bridge-session.json. */
  private async loadSession(fleetId: string): Promise<PersistedCommanderSession | null> {
    const filePath = this.sessionPath(fleetId);
    try {
      const content = await readFile(filePath, "utf-8");
      return safeJsonParse<PersistedCommanderSession>(content, { source: "commander.loadSession" });
    } catch {
      // Try legacy bridge-session.json for migration
      if (this.role === "flagship") {
        try {
          const legacyPath = join(this.fleetDir(fleetId), "bridge-session.json");
          const content = await readFile(legacyPath, "utf-8");
          const legacy = safeJsonParse<{ fleetId: string; sessionId: string | null; createdAt: string }>(content, { source: "commander.legacySession" });
          if (legacy) return { ...legacy, role: "flagship" };
        } catch {
          // No legacy file
        }
      }
      return null;
    }
  }
}
