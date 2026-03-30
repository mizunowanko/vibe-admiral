/**
 * Engine health monitoring: question timeouts, process liveness, heartbeat, and bulk resume.
 * Extracted from ws-server.ts (ADR-0016 Phase 1).
 */
import type { WebSocket } from "ws";
import type { ProcessManager } from "./process-manager.js";
import type { ShipManager } from "./ship-manager.js";
import type { FlagshipManager } from "./flagship.js";
import type { DockManager } from "./dock.js";
import type { CommanderManager } from "./commander.js";
import type { ServerMessage, StreamMessage, CommanderRole, Fleet, ResumeAllUnitResult } from "./types.js";

// ── Question Timeout Scanner ──

export interface QuestionTimeoutDeps {
  flagshipManager: FlagshipManager;
  dockManager: DockManager;
  processManager: ProcessManager;
  broadcast: (msg: ServerMessage) => void;
  QUESTION_TIMEOUT_MS: number;
}

export function startQuestionTimeoutScanner(deps: QuestionTimeoutDeps): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    scanQuestionTimeouts(deps);
  }, 30_000);
  timer.unref();
  return timer;
}

function scanQuestionTimeouts(deps: QuestionTimeoutDeps): void {
  const { flagshipManager, dockManager, processManager, broadcast, QUESTION_TIMEOUT_MS } = deps;
  const now = Date.now();
  const managers: Array<{ role: CommanderRole; manager: CommanderManager }> = [
    { role: "flagship", manager: flagshipManager },
    { role: "dock", manager: dockManager },
  ];

  for (const { role, manager } of managers) {
    const pending = manager.getSessionsWithPendingQuestion();

    for (const { fleetId, toolUseId, askedAt } of pending) {
      if (now - askedAt <= QUESTION_TIMEOUT_MS) continue;

      const roleLabel = role === "flagship" ? "Flagship" : "Dock";
      console.warn(
        `[ws-server] ${roleLabel} question for fleet ${fleetId} timed out after ${QUESTION_TIMEOUT_MS / 1000}s. Auto-answering.`,
      );

      // Clear pending state
      manager.clearPendingQuestion(fleetId);

      // Auto-answer with default message
      const autoAnswer = "No response from user (timed out)";
      const processId = `${role}-${fleetId}`;

      // Record in history
      const answerMsg: StreamMessage = {
        type: "user",
        content: autoAnswer,
        timestamp: Date.now(),
      };
      manager.addToHistory(fleetId, answerMsg);

      // Notify frontend
      const timeoutMsg: StreamMessage = {
        type: "system",
        subtype: "commander-status",
        content: `${roleLabel} question timed out — auto-answered with default response.`,
        timestamp: Date.now(),
      };
      manager.addToHistory(fleetId, timeoutMsg);
      broadcast({
        type: `${role}:stream`,
        data: { fleetId, message: answerMsg },
      });
      broadcast({
        type: `${role}:stream`,
        data: { fleetId, message: timeoutMsg },
      });

      // Clear pendingQuestion on frontend
      broadcast({
        type: `${role}:question-timeout`,
        data: { fleetId },
      });

      // Send tool_result to commander stdin
      processManager.sendToolResult(processId, toolUseId, autoAnswer);
    }
  }
}

// ── Process Liveness Check ──

export interface ProcessLivenessDeps {
  shipManager: ShipManager;
  processManager: ProcessManager;
}

export function startProcessLivenessCheck(deps: ProcessLivenessDeps): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    for (const ship of deps.shipManager.getAllShips()) {
      if (
        ship.phase !== "done" &&
        ship.phase !== "paused" &&
        ship.phase !== "abandoned" &&
        !deps.processManager.isRunning(ship.id)
      ) {
        if (!ship.processDead) {
          deps.shipManager.notifyProcessDead(ship.id);
        }
      }
    }
  }, 30_000);
  timer.unref();
  return timer;
}

// ── Heartbeat ──

export interface HeartbeatDeps {
  clients: Set<WebSocket>;
  clientAliveMap: WeakMap<WebSocket, boolean>;
  sendTo: (ws: WebSocket, msg: ServerMessage) => void;
  HEARTBEAT_INTERVAL_MS: number;
}

export function startHeartbeat(deps: HeartbeatDeps): ReturnType<typeof setInterval> {
  return setInterval(() => {
    for (const ws of deps.clients) {
      if (!deps.clientAliveMap.get(ws)) {
        console.log("[engine] Client heartbeat timeout — terminating dead connection");
        ws.terminate();
        deps.clients.delete(ws);
        continue;
      }
      deps.clientAliveMap.set(ws, false);
      // Native WS ping (handled by ws library)
      ws.ping();
      // Application-level ping (for browser clients that can't see native ping/pong)
      deps.sendTo(ws, { type: "ping" });
    }
  }, deps.HEARTBEAT_INTERVAL_MS);
}

// ── Resume All Units ──

export interface ResumeAllUnitsDeps {
  shipManager: ShipManager;
  processManager: ProcessManager;
  flagshipManager: FlagshipManager;
  dockManager: DockManager;
  loadFleets: () => Promise<Fleet[]>;
}

export async function resumeAllUnits(deps: ResumeAllUnitsDeps): Promise<ResumeAllUnitResult[]> {
  const { shipManager, processManager, flagshipManager, dockManager, loadFleets } = deps;
  const results: ResumeAllUnitResult[] = [];
  const fleets = await loadFleets();

  for (const fleet of fleets) {
    // --- Ships ---
    const ships = shipManager.getShipsByFleet(fleet.id);
    for (const ship of ships) {
      if (ship.phase === "done") {
        results.push({ type: "ship", id: ship.id, fleetId: fleet.id, label: `Ship #${ship.issueNumber} (${ship.issueTitle})`, status: "skipped", reason: "already done" });
        continue;
      }
      if (ship.phase === "abandoned") {
        results.push({ type: "ship", id: ship.id, fleetId: fleet.id, label: `Ship #${ship.issueNumber} (${ship.issueTitle})`, status: "skipped", reason: "abandoned" });
        continue;
      }
      if (processManager.isRunning(ship.id)) {
        results.push({ type: "ship", id: ship.id, fleetId: fleet.id, label: `Ship #${ship.issueNumber} (${ship.issueTitle})`, status: "skipped", reason: "already running" });
        continue;
      }
      const resumed = shipManager.retryShip(ship.id);
      if (resumed) {
        const method = ship.sessionId ? "session resume" : "re-sortie";
        results.push({ type: "ship", id: ship.id, fleetId: fleet.id, label: `Ship #${ship.issueNumber} (${ship.issueTitle})`, status: "resumed", reason: method });
      } else {
        results.push({ type: "ship", id: ship.id, fleetId: fleet.id, label: `Ship #${ship.issueNumber} (${ship.issueTitle})`, status: "error", reason: "retryShip failed" });
      }
    }

    // --- Flagship ---
    if (flagshipManager.hasSession(fleet.id)) {
      const flagshipResult = flagshipManager.resumeIfDead(fleet.id);
      if (flagshipResult.resumed) {
        results.push({ type: "flagship", id: `flagship-${fleet.id}`, fleetId: fleet.id, label: `Flagship (${fleet.name})`, status: "resumed", reason: flagshipResult.method });
      } else {
        results.push({ type: "flagship", id: `flagship-${fleet.id}`, fleetId: fleet.id, label: `Flagship (${fleet.name})`, status: "skipped", reason: flagshipResult.reason });
      }
    }

    // --- Dock ---
    if (dockManager.hasSession(fleet.id)) {
      const dockResult = dockManager.resumeIfDead(fleet.id);
      if (dockResult.resumed) {
        results.push({ type: "dock", id: `dock-${fleet.id}`, fleetId: fleet.id, label: `Dock (${fleet.name})`, status: "resumed", reason: dockResult.method });
      } else {
        results.push({ type: "dock", id: `dock-${fleet.id}`, fleetId: fleet.id, label: `Dock (${fleet.name})`, status: "skipped", reason: dockResult.reason });
      }
    }
  }

  return results;
}
