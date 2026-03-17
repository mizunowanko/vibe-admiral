import { appendFile, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { ProcessManager } from "./process-manager.js";
import type { StreamMessage, PersistedBridgeSession } from "./types.js";

const MAX_HISTORY = 500;
const ADMIRAL_DIR = join(homedir(), ".vibe-admiral");

export interface BridgeSession {
  id: string;
  fleetId: string;
  fleetPath: string;
  additionalDirs: string[];
  systemPrompt?: string;
  sessionId: string | null;
  history: StreamMessage[];
}

export class BridgeManager {
  private sessions = new Map<string, BridgeSession>();
  private processManager: ProcessManager;

  constructor(processManager: ProcessManager) {
    this.processManager = processManager;
  }

  /**
   * Launch a new Bridge session. If a persisted session exists with a valid
   * sessionId, attempt to resume the Claude CLI session.
   */
  async launch(
    fleetId: string,
    fleetPath: string,
    additionalDirs: string[],
    systemPrompt?: string,
  ): Promise<string> {
    const bridgeId = `bridge-${fleetId}`;

    // Load persisted history and session info
    const restoredHistory = await this.loadHistory(fleetId);
    const persisted = await this.loadSession(fleetId);

    const session: BridgeSession = {
      id: bridgeId,
      fleetId,
      fleetPath,
      additionalDirs,
      systemPrompt,
      sessionId: persisted?.sessionId ?? null,
      history: restoredHistory,
    };
    this.sessions.set(fleetId, session);

    if (session.sessionId) {
      // Try to resume the existing Claude CLI session
      this.processManager.resumeBridge(
        bridgeId,
        session.sessionId,
        fleetPath,
        additionalDirs,
        systemPrompt,
      );
    } else {
      this.processManager.launchBridge(
        bridgeId,
        fleetPath,
        additionalDirs,
        systemPrompt,
      );
    }
    return bridgeId;
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

    const bridgeId = `bridge-${fleetId}`;

    // Store user message in history (include image count, not full data, to limit memory)
    const historyEntry: StreamMessage = { type: "user", content: message };
    if (images && images.length > 0) {
      historyEntry.imageCount = images.length;
    }
    this.addToHistory(fleetId, historyEntry);

    // If process died, re-launch it
    if (!this.processManager.isRunning(bridgeId)) {
      if (session.sessionId) {
        this.processManager.resumeBridge(
          bridgeId,
          session.sessionId,
          session.fleetPath,
          session.additionalDirs,
          session.systemPrompt,
        );
      } else {
        this.processManager.launchBridge(
          bridgeId,
          session.fleetPath,
          session.additionalDirs,
          session.systemPrompt,
        );
      }
    }

    // Send immediately — writing to stdin also unblocks Bun's pipe handling.
    // Do NOT queue/defer: Bun blocks stdout when stdin pipe is idle,
    // so waiting for init creates a deadlock (init never arrives).
    this.processManager.sendMessage(bridgeId, message, images);
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

  stop(fleetId: string): void {
    const bridgeId = `bridge-${fleetId}`;
    this.processManager.kill(bridgeId);
    this.sessions.delete(fleetId);
  }

  stopAll(): void {
    for (const [fleetId] of this.sessions) {
      this.stop(fleetId);
    }
  }

  // --- Disk persistence ---

  private fleetDir(fleetId: string): string {
    return join(ADMIRAL_DIR, fleetId);
  }

  private historyPath(fleetId: string): string {
    return join(this.fleetDir(fleetId), "bridge-history.jsonl");
  }

  private sessionPath(fleetId: string): string {
    return join(this.fleetDir(fleetId), "bridge-session.json");
  }

  /** Append a single message to the JSONL history file. Fire-and-forget. */
  private persistHistoryEntry(fleetId: string, message: StreamMessage): void {
    const dir = this.fleetDir(fleetId);
    const filePath = this.historyPath(fleetId);
    const line = JSON.stringify(message) + "\n";
    mkdir(dir, { recursive: true })
      .then(() => appendFile(filePath, line))
      .then(async () => {
        // Rotate if file is too large (check line count periodically)
        const content = await readFile(filePath, "utf-8");
        const lines = content.trimEnd().split("\n");
        if (lines.length > MAX_HISTORY * 2) {
          const trimmed = lines.slice(-MAX_HISTORY).join("\n") + "\n";
          await writeFile(filePath, trimmed);
        }
      })
      .catch((err) => {
        console.warn("[bridge] Failed to persist history entry:", err);
      });
  }

  /** Load history from JSONL file. Returns [] if file doesn't exist. */
  private async loadHistory(fleetId: string): Promise<StreamMessage[]> {
    const filePath = this.historyPath(fleetId);
    try {
      await stat(filePath);
      const content = await readFile(filePath, "utf-8");
      const lines = content.trimEnd().split("\n").filter(Boolean);
      const messages: StreamMessage[] = [];
      for (const line of lines) {
        try {
          messages.push(JSON.parse(line) as StreamMessage);
        } catch {
          // Skip malformed lines
        }
      }
      // Return only the last MAX_HISTORY entries
      return messages.slice(-MAX_HISTORY);
    } catch {
      return [];
    }
  }

  /** Persist session metadata (sessionId) to disk. Fire-and-forget. */
  private persistSession(fleetId: string, sessionId: string): void {
    const dir = this.fleetDir(fleetId);
    const filePath = this.sessionPath(fleetId);
    const data: PersistedBridgeSession = {
      fleetId,
      sessionId,
      createdAt: new Date().toISOString(),
    };
    mkdir(dir, { recursive: true })
      .then(() => writeFile(filePath, JSON.stringify(data, null, 2)))
      .catch((err) => {
        console.warn("[bridge] Failed to persist session:", err);
      });
  }

  /** Load persisted session metadata. Returns null if not found. */
  private async loadSession(fleetId: string): Promise<PersistedBridgeSession | null> {
    const filePath = this.sessionPath(fleetId);
    try {
      const content = await readFile(filePath, "utf-8");
      return JSON.parse(content) as PersistedBridgeSession;
    } catch {
      return null;
    }
  }
}
