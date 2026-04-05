import { appendFile, readFile, writeFile, mkdir, stat, rename, copyFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessManagerLike } from "./process-manager.js";
import { getAdmiralHome } from "./admiral-home.js";
import type { StreamMessage, PersistedCommanderSession, CommanderRole, Dispatch, DispatchStatus } from "./types.js";

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

  constructor(processManager: ProcessManagerLike, role: CommanderRole) {
    this.processManager = processManager;
    this.role = role;
  }

  /**
   * Launch a new commander session. If a persisted session exists with a valid
   * sessionId, attempt to resume the Claude CLI session.
   *
   * @param admiralSkillsDir - Absolute path to vibe-admiral's skills/ directory.
   *   When provided, skills are deployed FROM this directory TO fleetPath/.claude/skills/.
   *   When omitted, falls back to fleetPath/skills/ (legacy behavior).
   * @param customInstructionsText - Fleet's custom instructions text (shared + role-specific).
   *   Deployed to fleetPath/.claude/rules/custom-instructions.md so it persists across
   *   context compaction and correctly overrides any repo-level custom-instructions.md.
   */
  async launch(
    fleetId: string,
    fleetPath: string,
    additionalDirs: string[],
    systemPrompt?: string,
    admiralSkillsDir?: string,
    customInstructionsText?: string,
  ): Promise<string> {
    const sessionId = `${this.role}-${fleetId}`;

    // Load persisted history and session info
    const restoredHistory = await this.loadHistory(fleetId);
    const persisted = await this.loadSession(fleetId);

    // Deploy skills, rules, and custom instructions to Fleet repo
    const deployedFiles: string[] = [];
    await this.deploySkills(fleetPath, deployedFiles, admiralSkillsDir);
    await this.deployRules(fleetPath, deployedFiles, admiralSkillsDir);
    await this.deployCustomInstructions(fleetPath, deployedFiles, customInstructionsText);

    const session: CommanderSession = {
      id: sessionId,
      role: this.role,
      fleetId,
      fleetPath,
      additionalDirs,
      systemPrompt,
      sessionId: persisted?.sessionId ?? null,
      history: restoredHistory,
      pendingToolUseId: null,
      questionAskedAt: null,
      dispatches: new Map(),
      deployedFiles,
    };
    this.sessions.set(fleetId, session);

    const commanderEnv = { VIBE_ADMIRAL_FLEET_ID: fleetId };

    if (session.sessionId) {
      this.processManager.resumeCommander(
        sessionId,
        session.sessionId,
        fleetPath,
        additionalDirs,
        systemPrompt,
        commanderEnv,
      );
    } else {
      this.processManager.launchCommander(
        sessionId,
        fleetPath,
        additionalDirs,
        systemPrompt,
        commanderEnv,
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
      return { resumed: true, method: "session resume" };
    } else {
      this.processManager.launchCommander(
        processId,
        session.fleetPath,
        session.additionalDirs,
        session.systemPrompt,
        commanderEnv,
      );
      return { resumed: true, method: "fresh launch" };
    }
  }

  setSessionId(fleetId: string, sessionId: string): void {
    const session = this.sessions.get(fleetId);
    if (session && !session.sessionId) {
      session.sessionId = sessionId;
      this.persistSession(fleetId, sessionId);
    }
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
      if (session.sessionId) {
        this.processManager.resumeCommander(
          processId,
          session.sessionId,
          session.fleetPath,
          session.additionalDirs,
          session.systemPrompt,
        );
      } else {
        this.processManager.launchCommander(
          processId,
          session.fleetPath,
          session.additionalDirs,
          session.systemPrompt,
        );
      }
    }

    // Send immediately — writing to stdin also unblocks Bun's pipe handling.
    this.processManager.sendMessage(processId, message, images);
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
   * When admiralSkillsDir is provided, skills are sourced from the Admiral repo's
   * skills/ directory (for Commanders running in Fleet repos).
   * When omitted, falls back to fleetPath/skills/ (legacy behavior).
   */
  protected async deploySkills(
    fleetPath: string,
    deployedFiles: string[],
    admiralSkillsDir?: string,
  ): Promise<void> {
    const skillsRoot = admiralSkillsDir ?? join(fleetPath, "skills");
    const skills = this.getSkillNames();
    for (const skillName of skills) {
      const src = join(skillsRoot, skillName, "SKILL.md");
      const dest = join(fleetPath, ".claude", "skills", skillName, "SKILL.md");
      try {
        await mkdir(join(fleetPath, ".claude", "skills", skillName), { recursive: true });
        await copyFile(src, dest);
        deployedFiles.push(dest);
      } catch {
        // Non-fatal: skill may not exist
      }
    }
  }

  /**
   * Deploy commander-rules.md to fleetPath/.claude/rules/.
   * Sources from the Admiral repo's .claude/rules/ when admiralSkillsDir is provided
   * (deriving the Admiral repo root from admiralSkillsDir).
   */
  protected async deployRules(
    fleetPath: string,
    deployedFiles: string[],
    admiralSkillsDir?: string,
  ): Promise<void> {
    if (!admiralSkillsDir) return;

    // admiralSkillsDir = <admiral-repo>/skills → Admiral repo root = parent of skills/
    const admiralRoot = join(admiralSkillsDir, "..");
    const src = join(admiralRoot, ".claude", "rules", "commander-rules.md");
    const destDir = join(fleetPath, ".claude", "rules");
    const dest = join(destDir, "commander-rules.md");
    try {
      await mkdir(destDir, { recursive: true });
      await copyFile(src, dest);
      deployedFiles.push(dest);
    } catch {
      console.warn(`[${this.role}] Failed to deploy commander-rules.md`);
    }
  }

  /**
   * Deploy Fleet custom instructions as .claude/rules/custom-instructions.md.
   * This overwrites any existing custom-instructions.md in the Fleet repo,
   * ensuring Fleet settings take precedence over repo-level instructions.
   * The file is tracked for cleanup on stop().
   */
  protected async deployCustomInstructions(
    fleetPath: string,
    deployedFiles: string[],
    customInstructionsText?: string,
  ): Promise<void> {
    const destDir = join(fleetPath, ".claude", "rules");
    const dest = join(destDir, "custom-instructions.md");

    if (!customInstructionsText) {
      return;
    }

    await mkdir(destDir, { recursive: true });
    await writeFile(dest, `## Custom Instructions\n\n${customInstructionsText}`, "utf-8");
    deployedFiles.push(dest);
  }

  /** Get skill names to deploy. Override in subclasses. */
  protected getSkillNames(): string[] {
    return [];
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
      try {
        messages.push(JSON.parse(line) as StreamMessage);
      } catch {
        // Skip malformed lines
      }
    }
    return messages.slice(-MAX_HISTORY);
  }

  /** Persist session metadata (sessionId) to disk. Fire-and-forget. */
  private persistSession(fleetId: string, sessionId: string): void {
    const dir = this.fleetDir(fleetId);
    const filePath = this.sessionPath(fleetId);
    const data: PersistedCommanderSession = {
      fleetId,
      role: this.role,
      sessionId,
      createdAt: new Date().toISOString(),
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
      return JSON.parse(content) as PersistedCommanderSession;
    } catch {
      // Try legacy bridge-session.json for migration
      if (this.role === "flagship") {
        try {
          const legacyPath = join(this.fleetDir(fleetId), "bridge-session.json");
          const content = await readFile(legacyPath, "utf-8");
          const legacy = JSON.parse(content) as { fleetId: string; sessionId: string | null; createdAt: string };
          return { ...legacy, role: "flagship" };
        } catch {
          // No legacy file
        }
      }
      return null;
    }
  }
}
