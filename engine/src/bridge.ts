import { ProcessManager } from "./process-manager.js";
import type { StreamMessage } from "./types.js";

export interface BridgeSession {
  id: string;
  fleetId: string;
  fleetPath: string;
  additionalDirs: string[];
  history: StreamMessage[];
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
  ): string {
    const bridgeId = `bridge-${fleetId}`;
    const session: BridgeSession = {
      id: bridgeId,
      fleetId,
      fleetPath,
      additionalDirs,
      history: [],
    };
    this.sessions.set(fleetId, session);
    this.processManager.launchBridge(bridgeId, fleetPath, additionalDirs);
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

    // If process is still running, send to stdin
    if (this.processManager.isRunning(bridgeId)) {
      this.processManager.sendMessage(bridgeId, message);
      return true;
    }

    // Otherwise, launch a new bridge process with the message
    this.processManager.launchBridge(
      bridgeId,
      session.fleetPath,
      session.additionalDirs,
    );
    // Send message after brief delay for process to start
    setTimeout(() => {
      this.processManager.sendMessage(bridgeId, message);
    }, 500);
    return true;
  }

  addToHistory(fleetId: string, message: StreamMessage): void {
    const session = this.sessions.get(fleetId);
    if (session) {
      session.history.push(message);
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
