/**
 * Ship/Escort lifecycle event processing and process event routing.
 * Extracted from ws-server.ts (ADR-0016 Phase 1).
 */
import { isRetryableError, type ProcessManagerLike } from "./process-manager.js";
import type { ShipManager } from "./ship-manager.js";
import type { FlagshipManager } from "./flagship.js";
import type { DockManager } from "./dock.js";
import type { CommanderManager } from "./commander.js";
import type { StateSync } from "./state-sync.js";
import type { EscortManager } from "./escort-manager.js";
import type { DispatchManager } from "./dispatch-manager.js";
import type { Lookout } from "./lookout.js";
import type { LookoutAlert } from "./lookout.js";
import {
  parseStreamMessage,
  extractSessionId,
  extractResultUsage,
} from "./stream-parser.js";
import type { FleetDatabase } from "./db.js";
import type { ServerMessage, StreamMessage, CommanderRole, HeadsUpNotification } from "./types.js";

export interface ShipLifecycleDeps {
  processManager: ProcessManagerLike;
  shipManager: ShipManager;
  flagshipManager: FlagshipManager;
  dockManager: DockManager;
  stateSync: StateSync;
  escortManager: EscortManager;
  dispatchManager: DispatchManager;
  lookout: Lookout;
  getDatabase: () => FleetDatabase | null;
  commanderFirstData: Set<string>;
  broadcast: (msg: ServerMessage) => void;
  syncCaffeinateCount: () => void;
}

// ── Helpers ──

/** Resolve a commander manager by process ID prefix. */
function resolveCommander(
  id: string,
  flagshipManager: FlagshipManager,
  dockManager: DockManager,
): { role: CommanderRole; manager: CommanderManager; fleetId: string } | null {
  if (id.startsWith("flagship-")) {
    return { role: "flagship", manager: flagshipManager, fleetId: id.replace("flagship-", "") };
  }
  if (id.startsWith("dock-")) {
    return { role: "dock", manager: dockManager, fleetId: id.replace("dock-", "") };
  }
  return null;
}

/** Check if a process ID belongs to a commander (Dock or Flagship). */
function isCommanderProcess(id: string): boolean {
  return id.startsWith("flagship-") || id.startsWith("dock-");
}

function detectPRCreation(
  id: string,
  msg: StreamMessage,
  shipManager: ShipManager,
  broadcast: (msg: ServerMessage) => void,
): void {
  if (!msg.content) return;
  // Match GitHub PR URLs in assistant or result messages
  if (msg.type !== "assistant" && msg.type !== "result") return;

  const prUrlMatch = msg.content.match(
    /https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/,
  );
  if (!prUrlMatch) return;

  const ship = shipManager.getShip(id);
  if (!ship || ship.prUrl) return; // Already detected

  const prUrl = prUrlMatch[0];

  // Store PR URL on ship (DB + runtime)
  shipManager.setPrUrl(id, prUrl);

  // Broadcast PR detection as ship:updated notification — Frontend fetches via REST API
  broadcast({ type: "ship:updated", data: { shipId: id } });
}

function detectCompactStatus(
  id: string,
  raw: Record<string, unknown>,
  shipManager: ShipManager,
  flagshipManager: FlagshipManager,
  broadcast: (msg: ServerMessage) => void,
): void {
  // Detect SDKStatusMessage: { type: "system", subtype: "status", status: "compacting" | null }
  if (raw.type !== "system" || raw.subtype !== "status") return;

  const status = raw.status as string | null | undefined;
  // Only handle compact-related status changes
  if (status !== "compacting" && status !== null && status !== undefined) return;
  const isCompacting = status === "compacting";
  const ship = shipManager.getShip(id);
  if (!ship) return;

  shipManager.setIsCompacting(id, isCompacting);
  broadcast({
    type: "ship:compacting",
    data: { id, isCompacting },
  });

  // Also inject into Flagship chat (Ship management is Flagship's domain)
  if (isCompacting) {
    const compactMsg = {
      type: "system" as const,
      subtype: "ship-status" as const,
      content: `Ship #${ship.issueNumber} (${ship.issueTitle}): compacting context...`,
      meta: {
        category: "ship-status" as const,
        shipId: id,
        issueNumber: ship.issueNumber,
        issueTitle: ship.issueTitle,
      },
      timestamp: Date.now(),
    };
    flagshipManager.addToHistory(ship.fleetId, compactMsg);
    broadcast({
      type: "flagship:stream",
      data: { fleetId: ship.fleetId, message: compactMsg },
    });
  }
}

function logShipMessage(
  id: string,
  msg: StreamMessage,
  shipManager: ShipManager,
): void {
  const ship = shipManager.getShip(id);
  const prefix = ship
    ? `[Ship#${ship.issueNumber}]`
    : `[Ship:${id.slice(0, 8)}]`;
  const verbose = process.env.SHIP_LOG_VERBOSE === "true";
  const maxLen = verbose ? 1000 : 150;

  switch (msg.type) {
    case "assistant": {
      if (!msg.content) break;
      const preview =
        msg.content.length > maxLen
          ? msg.content.slice(0, maxLen) + "..."
          : msg.content;
      console.log(`${prefix} ${preview}`);
      break;
    }
    case "tool_use": {
      const inputSummary = msg.toolInput
        ? ` ${JSON.stringify(msg.toolInput).slice(0, 80)}`
        : "";
      console.log(`${prefix} [${msg.tool}]${inputSummary}`);
      break;
    }
    case "result": {
      if (!msg.content) break;
      const resultPreview =
        msg.content.length > maxLen
          ? msg.content.slice(0, maxLen) + "..."
          : msg.content;
      console.log(`${prefix} [result] ${resultPreview}`);
      break;
    }
    case "system": {
      if (msg.content) {
        console.log(`${prefix} [system] ${msg.content.slice(0, maxLen)}`);
      }
      break;
    }
  }
}

// ── Process Event Routing ──

export function setupProcessEvents(deps: ShipLifecycleDeps): void {
  const {
    processManager, shipManager, flagshipManager, dockManager,
    stateSync, escortManager, dispatchManager, getDatabase,
    commanderFirstData, broadcast, syncCaffeinateCount,
  } = deps;

  processManager.on("data", (id: string, msg: Record<string, unknown>) => {
    // Route Dispatch stream data to frontend (independent process)
    if (dispatchManager.isDispatchProcess(id)) {
      const dispatch = dispatchManager.getDispatch(id);
      if (!dispatch) return;

      const parsed = parseStreamMessage(msg);
      if (parsed) {
        // Capture result text for completion notification
        if (parsed.type === "result" && parsed.content) {
          dispatchManager.setResult(id, parsed.content);
        }
        // Stream all non-result messages to frontend
        if (parsed.type !== "result") {
          broadcast({
            type: "dispatch:stream",
            data: {
              id,
              fleetId: dispatch.fleetId,
              parentRole: dispatch.parentRole,
              message: parsed,
            },
          });
        }
      }
      return;
    }

    // Route Escort stream data to frontend (separate from Ship stream)
    if (escortManager.isEscortProcess(id)) {
      const parentShipId = escortManager.findShipIdByEscortId(id);
      if (parentShipId) {
        const parentShip = shipManager.getShip(parentShipId);
        const parsed = parseStreamMessage(msg);

        // Extract sessionId from Escort init messages and persist to escorts table
        const sessionId = extractSessionId(msg);
        if (sessionId) {
          escortManager.setEscortSessionId(id, sessionId);
        }

        // Extract token usage from Escort result messages and accumulate in DB (#800)
        const resultUsage = extractResultUsage(msg);
        if (resultUsage) {
          const db = getDatabase();
          if (db) {
            db.updateEscortUsage(id, resultUsage.inputTokens, resultUsage.outputTokens, resultUsage.costUsd);
            console.log(
              `[escort-usage] Escort ${id.slice(0, 8)}... for Ship ${parentShipId.slice(0, 8)}...: ` +
              `+${resultUsage.inputTokens.toLocaleString()} in / +${resultUsage.outputTokens.toLocaleString()} out / $${resultUsage.costUsd.toFixed(4)}`,
            );
          }
        }

        if (parsed && parsed.type !== "result") {
          // Mark all Escort messages with escort-log metadata for visual distinction.
          // Previously only assistant messages were marked, causing tool_use/tool_result
          // to appear as Ship messages in the chat panel (#729).
          parsed.meta = {
            ...parsed.meta,
            category: "escort-log",
          };
          broadcast({
            type: "escort:stream",
            data: {
              id: parentShipId,
              escortId: id,
              fleetId: parentShip?.fleetId,
              issueNumber: parentShip?.issueNumber,
              message: parsed,
            },
          });
        }
      }
      return;
    }

    // Route to commander (Dock/Flagship) or Ship
    const commander = resolveCommander(id, flagshipManager, dockManager);
    if (commander) {
      const { role, manager, fleetId } = commander;
      const streamType = `${role}:stream` as const;
      const questionType = `${role}:question` as const;

      // Extract sessionId from commander init messages
      const sessionId = extractSessionId(msg);
      if (sessionId) {
        manager.setSessionId(fleetId, sessionId);
        console.log(
          `[ws-server] ${role} ${id} sessionId captured: ${sessionId.slice(0, 12)}...`,
        );
      }

      // Emit "connected" status on first data from commander CLI
      if (!commanderFirstData.has(id)) {
        commanderFirstData.add(id);
        const pid = processManager.getPid(id);
        const roleLabel = role === "flagship" ? "Flagship" : "Dock";
        const connMsg = {
          type: "system" as const,
          subtype: "commander-status" as const,
          content: `${roleLabel} CLI connected${pid ? ` (pid: ${pid})` : ""}`,
          timestamp: Date.now(),
        };
        manager.addToHistory(fleetId, connMsg);
        broadcast({
          type: streamType,
          data: { fleetId, message: connMsg },
        });
      }

      const parsed = parseStreamMessage(msg);
      if (parsed) {
        // AskUserQuestion tool_use — forward as commander:question
        if (
          parsed.type === "tool_use" &&
          parsed.tool === "AskUserQuestion"
        ) {
          const toolInput = parsed.toolInput as Record<string, unknown> | undefined;
          const question = toolInput?.question as string | undefined;
          const toolUseId = parsed.toolUseId as string | undefined;
          const roleLabel = role === "flagship" ? "Flagship" : "Dock";
          const questionMessage: StreamMessage = {
            type: "question",
            content: question ?? `${roleLabel} is asking a question`,
            ...(toolUseId ? { toolUseId } : {}),
          };
          manager.addToHistory(fleetId, questionMessage);
          if (toolUseId) {
            manager.setPendingQuestion(fleetId, toolUseId);
          }
          broadcast({
            type: questionType,
            data: { fleetId, message: questionMessage },
          });
        } else if (parsed.type !== "result") {
          manager.addToHistory(fleetId, parsed);
          broadcast({
            type: streamType,
            data: { fleetId, message: parsed },
          });
        }
      }
    } else {
      // Update lastOutputAt for Lookout no-output detection
      shipManager.setLastOutputAt(id, Date.now());

      // Extract sessionId from init messages (before parsing drops them)
      const sessionId = extractSessionId(msg);
      if (sessionId) {
        const ship = shipManager.getShip(id);
        if (ship && !ship.sessionId) {
          shipManager.setSessionId(id, sessionId);
          console.log(
            `[ws-server] Ship ${id.slice(0, 8)}... sessionId captured: ${sessionId.slice(0, 12)}...`,
          );
        }
      }

      // Detect compact status changes from raw message (before parsing)
      detectCompactStatus(id, msg, shipManager, flagshipManager, broadcast);

      // Ship stream — parse raw CLI JSON before broadcast
      const parsed = parseStreamMessage(msg);
      if (parsed) {
        // Detect PR URL in assistant/result messages (before filtering)
        detectPRCreation(id, parsed, shipManager, broadcast);

        // Skip result messages — they duplicate the last assistant message
        if (parsed.type !== "result") {
          logShipMessage(id, parsed, shipManager);
          broadcast({
            type: "ship:stream",
            data: { id, message: parsed },
          });
        }
      }
    }
  });

  processManager.on("exit", (id: string, code: number | null) => {
    // Handle Dispatch process exit
    if (dispatchManager.isDispatchProcess(id)) {
      console.log(`[ws-server] Dispatch ${id.slice(0, 16)}... exited (code=${code})`);
      dispatchManager.onProcessExit(id, code);
      return;
    }

    // Handle Escort-Ship process exit
    if (escortManager.isEscortProcess(id)) {
      const parentShipId = escortManager.findShipIdByEscortId(id);
      escortManager.onEscortExit(id, code);
      if (parentShipId) {
        const parentShip = shipManager.getShip(parentShipId);
        broadcast({
          type: "escort:completed",
          data: {
            id: parentShipId,
            escortId: id,
            exitCode: code,
            fleetId: parentShip?.fleetId,
            issueNumber: parentShip?.issueNumber,
          },
        });

        // Inject notification into Flagship chat
        if (parentShip) {
          const escortMsg = {
            type: "system" as const,
            subtype: "ship-status" as const,
            content: `Ship #${parentShip.issueNumber} (${parentShip.issueTitle}): Escort review completed (exit ${code})`,
            meta: {
              category: "ship-status" as const,
              shipId: parentShipId,
              issueNumber: parentShip.issueNumber,
              issueTitle: parentShip.issueTitle,
            },
            timestamp: Date.now(),
          };
          flagshipManager.addToHistory(parentShip.fleetId, escortMsg);
          broadcast({
            type: "flagship:stream",
            data: { fleetId: parentShip.fleetId, message: escortMsg },
          });
        }
      }
      return;
    }

    const exitCommander = resolveCommander(id, flagshipManager, dockManager);
    if (exitCommander) {
      commanderFirstData.delete(id);
      const { role, fleetId } = exitCommander;
      const roleLabel = role === "flagship" ? "Flagship" : "Dock";
      console.log(`${roleLabel} ${id} exited with code ${code}`);
      broadcast({
        type: `${role}:stream`,
        data: {
          fleetId,
          message: {
            type: code === 0 ? "system" : "error",
            content:
              code === 0
                ? `${roleLabel} session ended.`
                : `${roleLabel} process exited with code ${code}.`,
            timestamp: Date.now(),
          },
        },
      });
    } else {
      console.log(`Ship ${id} exited with code ${code}`);
      const ship = shipManager.getShip(id);
      if (!ship) {
        console.warn(`[ws-server] Ship ${id} exited but is not tracked — skipping cleanup`);
        return;
      }
      // Ship declares "done" via phase-transition REST API before exiting.
      // If the process exits while in "done" phase, treat as success.
      // "merging" is NOT treated as success — the Ship must explicitly
      // transition to "done" after verifying PR merge. Process death in
      // merging phase triggers the failure path, which has rescue logic
      // to check if the PR was actually merged (#761).
      const successPhases = new Set(["done", "paused", "abandoned"]);
      if (successPhases.has(ship.phase)) {
        stateSync.onProcessExit(id, true).catch(console.error);
      } else {
        // Process exited without declaring done — treat as failure.
        stateSync.onProcessExit(id, false).catch(console.error);
      }
    }

    syncCaffeinateCount();
  });

  processManager.on("spawn", () => {
    syncCaffeinateCount();
  });

  processManager.on("rate-limit", (id: string) => {
    if (isCommanderProcess(id)) {
      console.warn(`[ws-server] Commander ${id} hit rate limit`);
    } else {
      console.warn(
        `[ws-server] Ship ${id.slice(0, 8)}... hit rate limit — backoff will apply on next retry`,
      );
      shipManager.setLastRateLimitAt(id, Date.now());
    }
    // Notify Ship's own chat with a non-error status (#712)
    const ship = shipManager.getShip(id);
    if (ship) {
      broadcast({
        type: "ship:stream",
        data: {
          id,
          message: {
            type: "system" as const,
            subtype: "rate-limit-status" as const,
            content: "Rate limit detected — retrying automatically...",
            timestamp: Date.now(),
          },
        },
      });
    }
    // Notify frontend for global status indicator banner (#699)
    broadcast({ type: "rate-limit:detected", data: { processId: id } });
  });

  processManager.on("error", (id: string, error: Error) => {
    console.error(`Process ${id} error:`, error.message);

    // Retryable errors (rate limit, 429, 500, etc.) are handled by
    // process-manager retry logic. Don't broadcast them to the frontend
    // to avoid flooding chat panels with transient error messages (#699).
    if (isRetryableError(error.message)) return;

    const errCommander = resolveCommander(id, flagshipManager, dockManager);
    if (errCommander) {
      const { role, manager, fleetId } = errCommander;
      const hadData = commanderFirstData.has(id);
      // Don't delete commanderFirstData here — only delete on process exit.
      // Deleting on error caused subsequent errors to be incorrectly treated
      // as "failed to start" and broadcast as ${role}:stream (#699).
      const roleLabel = role === "flagship" ? "Flagship" : "Dock";
      // Only show "Failed to start" if commander never sent data (spawn failure)
      if (!hadData) {
        const errMsg = {
          type: "system" as const,
          subtype: "commander-status" as const,
          content: `Failed to start ${roleLabel} CLI: ${error.message}`,
          timestamp: Date.now(),
        };
        manager.addToHistory(fleetId, errMsg);
        broadcast({
          type: `${role}:stream`,
          data: { fleetId, message: errMsg },
        });
      }
    }
    broadcast({
      type: "error",
      data: { source: id, message: error.message },
    });
  });
}

// ── Ship Status Handler ──

export interface ShipStatusDeps {
  shipManager: ShipManager;
  flagshipManager: FlagshipManager;
  processManager: ProcessManagerLike;
  broadcast: (msg: ServerMessage) => void;
}

export function setupShipStatusHandler(deps: ShipStatusDeps): void {
  const { shipManager, flagshipManager, processManager, broadcast } = deps;

  shipManager.setPhaseChangeHandler((id, phase, detail) => {
    const ship = shipManager.getShip(id);

    // Event Notification pattern: send minimal notification, Frontend fetches via REST API
    if (phase === "done") {
      broadcast({ type: "ship:done", data: { shipId: id } });
    } else {
      broadcast({ type: "ship:updated", data: { shipId: id } });
    }

    // Inject Ship status into Flagship chat (Ship management is Flagship's domain)
    if (ship) {
      const resumeInfo = detail === "Process dead"
        ? `\nShip ID: ${ship.id}\nResumable: ${ship.sessionId ? "yes (session available)" : "no (no session — re-sortie only)"}\nWorktree: ${ship.worktreePath}`
        : "";
      const statusMessage = {
        type: "system" as const,
        subtype: "ship-status" as const,
        content: `Ship #${ship.issueNumber} (${ship.issueTitle}): ${phase}${detail ? ` — ${detail}` : ""}${resumeInfo}`,
        meta: {
          category: "ship-status" as const,
          shipId: id,
          issueNumber: ship.issueNumber,
          issueTitle: ship.issueTitle,
        },
        timestamp: Date.now(),
      };
      flagshipManager.addToHistory(ship.fleetId, statusMessage);
      broadcast({
        type: "flagship:stream",
        data: { fleetId: ship.fleetId, message: statusMessage },
      });

      // Send phase change to Flagship stdin if Flagship is running
      const flagshipId = `flagship-${ship.fleetId}`;
      if (processManager.isRunning(flagshipId)) {
        processManager.sendMessage(
          flagshipId,
          statusMessage.content,
        );
      }
    }
  });
}

// ── Ship Created Handler ──

export function setupShipCreatedHandler(
  shipManager: ShipManager,
  broadcast: (msg: ServerMessage) => void,
): void {
  shipManager.setShipCreatedHandler((id) => {
    broadcast({ type: "ship:created", data: { shipId: id } });
  });
}

// ── Lookout Setup ──

export interface LookoutDeps {
  shipManager: ShipManager;
  flagshipManager: FlagshipManager;
  processManager: ProcessManagerLike;
  escortManager: EscortManager;
  lookout: Lookout;
  broadcast: (msg: ServerMessage) => void;
}

export function setupLookout(deps: LookoutDeps): void {
  const { shipManager, flagshipManager, processManager, escortManager, lookout, broadcast } = deps;

  lookout.setAlertHandler((alert: LookoutAlert) => {
    const ship = shipManager.getShip(alert.shipId);
    if (!ship) return;

    const flagshipId = `flagship-${alert.fleetId}`;

    // Build system message for Flagship chat (Lookout alerts are Ship management)
    const alertMessage: StreamMessage = {
      type: "system",
      subtype: "lookout-alert",
      content: `[Lookout Alert] ${alert.message}`,
      meta: {
        category: "lookout-alert",
        issueNumber: alert.issueNumber,
        issueTitle: alert.issueTitle,
        alertType: alert.alertType,
        shipId: alert.shipId,
        branchName: ship.branchName,
      },
      timestamp: Date.now(),
    };

    // Add to Flagship history and broadcast to frontend
    flagshipManager.addToHistory(alert.fleetId, alertMessage);
    broadcast({
      type: "flagship:stream",
      data: { fleetId: alert.fleetId, message: alertMessage },
    });

    // Send to Flagship stdin if Flagship is running
    if (processManager.isRunning(flagshipId)) {
      processManager.sendMessage(
        flagshipId,
        `[Lookout Alert] ${alert.message}`,
      );
    }
  });

  lookout.start();

  // Escort death notifications → Flagship chat
  escortManager.setEscortDeathHandler((shipId, message) => {
    const ship = shipManager.getShip(shipId);
    if (!ship) return;

    const deathMsg: StreamMessage = {
      type: "system",
      subtype: "ship-status",
      content: `[Escort Death] ${message}`,
      meta: {
        category: "ship-status",
        shipId,
        issueNumber: ship.issueNumber,
        issueTitle: ship.issueTitle,
      },
      timestamp: Date.now(),
    };
    flagshipManager.addToHistory(ship.fleetId, deathMsg);
    broadcast({
      type: "flagship:stream",
      data: { fleetId: ship.fleetId, message: deathMsg },
    });

    const flagshipId = `flagship-${ship.fleetId}`;
    if (processManager.isRunning(flagshipId)) {
      processManager.sendMessage(flagshipId, `[Escort Death] ${message}`);
    }
  });
}

// ── Heads-Up Notification ──

export interface HeadsUpDeps {
  flagshipManager: FlagshipManager;
  dockManager: DockManager;
  processManager: ProcessManagerLike;
  broadcast: (msg: ServerMessage) => void;
}

/** Deliver a heads-up notification from one Commander to another. */
export function deliverHeadsUp(deps: HeadsUpDeps, notification: HeadsUpNotification): boolean {
  const { flagshipManager, dockManager, processManager, broadcast } = deps;

  const targetManager: CommanderManager = notification.to === "flagship"
    ? flagshipManager
    : dockManager;

  if (!targetManager.hasSession(notification.fleetId)) {
    return false;
  }

  const fromLabel = notification.from === "flagship" ? "Flagship" : "Dock";
  const toLabel = notification.to === "flagship" ? "Flagship" : "Dock";

  // Build human-readable message for Commander stdin
  const lines = [
    `[heads-up from ${fromLabel}]`,
    `Summary: ${notification.summary}`,
    `Severity: ${notification.severity}`,
  ];
  if (notification.shipId || notification.issueNumber !== undefined) {
    const parts: string[] = [];
    if (notification.shipId) parts.push(`Ship: ${notification.shipId}`);
    if (notification.issueNumber !== undefined) parts.push(`Issue #${notification.issueNumber}`);
    lines.push(parts.join(" / "));
  }
  lines.push(`Investigation needed: ${notification.needsInvestigation ? "yes" : "no"}`);
  lines.push("");
  lines.push("Please create an Issue if appropriate, or take other action.");
  const textContent = lines.join("\n");

  // Create system message for history + frontend
  const headsUpMessage: StreamMessage = {
    type: "system",
    subtype: "heads-up",
    content: textContent,
    meta: {
      category: "heads-up",
      ...(notification.shipId ? { shipId: notification.shipId } : {}),
      ...(notification.issueNumber !== undefined ? { issueNumber: notification.issueNumber } : {}),
    },
    timestamp: Date.now(),
  };

  // Add to target Commander's history
  targetManager.addToHistory(notification.fleetId, headsUpMessage);

  // Broadcast to frontend
  broadcast({
    type: `${notification.to}:stream`,
    data: { fleetId: notification.fleetId, message: headsUpMessage },
  });

  // Send to target Commander's stdin if running
  const targetId = `${notification.to}-${notification.fleetId}`;
  if (processManager.isRunning(targetId)) {
    processManager.sendMessage(targetId, textContent);
  }

  console.log(`[engine] Heads-up delivered: ${fromLabel} → ${toLabel} (fleet ${notification.fleetId.slice(0, 8)}...): ${notification.summary.slice(0, 80)}`);
  return true;
}
