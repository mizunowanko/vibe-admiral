import { appendFile, readFile, writeFile, mkdir, stat, rename, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { ProcessManager } from "./process-manager.js";
import { getAdmiralHome } from "./admiral-home.js";
import type { StreamMessage, PersistedCommanderSession, CommanderRole } from "./types.js";

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
}

/**
 * Shared session lifecycle manager for Dock and Flagship.
 * Both roles use the same Claude CLI interactive session model,
 * differing only in system prompt, skills, and request routing.
 */
export class CommanderManager {
  private sessions = new Map<string, CommanderSession>();
  protected processManager: ProcessManager;
  private appendCount = 0;
  protected readonly role: CommanderRole;

  constructor(processManager: ProcessManager, role: CommanderRole) {
    this.processManager = processManager;
    this.role = role;
  }

  /**
   * Launch a new commander session. If a persisted session exists with a valid
   * sessionId, attempt to resume the Claude CLI session.
   */
  async launch(
    fleetId: string,
    fleetPath: string,
    additionalDirs: string[],
    systemPrompt?: string,
  ): Promise<string> {
    const sessionId = `${this.role}-${fleetId}`;

    // Load persisted history and session info
    const restoredHistory = await this.loadHistory(fleetId);
    const persisted = await this.loadSession(fleetId);

    // Deploy skills
    await this.deploySkills(fleetPath);

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
    };
    this.sessions.set(fleetId, session);

    if (session.sessionId) {
      this.processManager.resumeCommander(
        sessionId,
        session.sessionId,
        fleetPath,
        additionalDirs,
        systemPrompt,
      );
    } else {
      this.processManager.launchCommander(
        sessionId,
        fleetPath,
        additionalDirs,
        systemPrompt,
      );
    }
    return sessionId;
  }

  hasSession(fleetId: string): boolean {
    return this.sessions.has(fleetId);
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

  stop(fleetId: string): void {
    const processId = `${this.role}-${fleetId}`;
    this.processManager.kill(processId);
    this.sessions.delete(fleetId);
  }

  stopAll(): void {
    for (const [fleetId] of this.sessions) {
      this.stop(fleetId);
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
   * Deploy role-specific skills from the repo's skills/ directory to
   * fleetPath/.claude/skills/ so that Claude Code can discover them.
   * Override in subclasses to customize deployed skills.
   */
  protected async deploySkills(fleetPath: string): Promise<void> {
    const skills = this.getSkillNames();
    for (const skillName of skills) {
      const src = join(fleetPath, "skills", skillName, "SKILL.md");
      const destDir = join(fleetPath, ".claude", "skills", skillName);
      try {
        await mkdir(destDir, { recursive: true });
        await copyFile(src, join(destDir, "SKILL.md"));
      } catch {
        // Non-fatal: skill may not exist in this repo
      }
    }
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
