import { ProcessManager } from "./process-manager.js";
import type { StreamMessage } from "./types.js";

const MAX_HISTORY = 500;

export interface BridgeSession {
  id: string;
  fleetId: string;
  fleetPath: string;
  additionalDirs: string[];
  systemPrompt?: string;
  history: StreamMessage[];
  ready: boolean;
  pendingMessages: string[];
}

export class BridgeManager {
  private sessions = new Map<string, BridgeSession>();
  private processManager: ProcessManager;

  constructor(processManager: ProcessManager) {
    this.processManager = processManager;
  }

  launch(
    fleetId: string,
    fleetPath: string,
    additionalDirs: string[],
    systemPrompt?: string,
  ): string {
    const bridgeId = `bridge-${fleetId}`;
    const session: BridgeSession = {
      id: bridgeId,
      fleetId,
      fleetPath,
      additionalDirs,
      systemPrompt,
      history: [],
      ready: false,
      pendingMessages: [],
    };
    this.sessions.set(fleetId, session);
    this.processManager.launchBridge(
      bridgeId,
      fleetPath,
      additionalDirs,
      systemPrompt,
    );
    return bridgeId;
  }

  hasSession(fleetId: string): boolean {
    return this.sessions.has(fleetId);
  }

  send(fleetId: string, message: string): boolean {
    const session = this.sessions.get(fleetId);
    if (!session) return false;

    const bridgeId = `bridge-${fleetId}`;

    // Store user message in history
    session.history.push({ type: "user", content: message });

    // If process died, re-launch it
    if (!this.processManager.isRunning(bridgeId)) {
      session.ready = false;
      this.processManager.launchBridge(
        bridgeId,
        session.fleetPath,
        session.additionalDirs,
        session.systemPrompt,
      );
    }

    // Queue message if process is not ready yet, otherwise send immediately
    if (!session.ready) {
      session.pendingMessages.push(message);
    } else {
      this.processManager.sendMessage(bridgeId, message);
    }
    return true;
  }

  onBridgeReady(fleetId: string): void {
    const session = this.sessions.get(fleetId);
    if (!session) return;

    session.ready = true;

    // Flush pending messages
    const bridgeId = `bridge-${fleetId}`;
    for (const msg of session.pendingMessages) {
      this.processManager.sendMessage(bridgeId, msg);
    }
    session.pendingMessages = [];
  }

  addToHistory(fleetId: string, message: StreamMessage): void {
    const session = this.sessions.get(fleetId);
    if (session) {
      session.history.push(message);
      if (session.history.length > MAX_HISTORY) {
        session.history = session.history.slice(-MAX_HISTORY);
      }
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
}
