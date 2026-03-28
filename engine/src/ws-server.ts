import { WebSocketServer, type WebSocket } from "ws";
import { createServer, type Server as HttpServer } from "node:http";
import { readFile, writeFile, mkdir, stat, readdir, realpath } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { ProcessManager } from "./process-manager.js";
import { ShipManager } from "./ship-manager.js";
import { FlagshipManager } from "./flagship.js";
import { DockManager } from "./dock.js";
import type { CommanderManager } from "./commander.js";
import { StatusManager } from "./status-manager.js";
import { StateSync } from "./state-sync.js";
import { FlagshipRequestHandler } from "./bridge-request-handler.js";
import * as github from "./github.js";
import {
  parseStreamMessage,
  extractSessionId,
} from "./stream-parser.js";
import { buildFlagshipSystemPrompt } from "./flagship-system-prompt.js";
import { buildDockSystemPrompt } from "./dock-system-prompt.js";
import { Lookout } from "./lookout.js";
import type { LookoutAlert } from "./lookout.js";
import { EscortManager } from "./escort-manager.js";
import { ShipActorManager } from "./ship-actor-manager.js";
import { DispatchManager } from "./dispatch-manager.js";
import { initFleetDatabase } from "./db.js";
import type { FleetDatabase } from "./db.js";
import { getAdmiralHome } from "./admiral-home.js";
import { createApiHandler } from "./api-server.js";
import type { Fleet, FleetRepo, FleetSkillSources, FleetGateSettings, GateType, CustomInstructions, ClientMessage, StreamMessage, CommanderRole } from "./types.js";

const FLEETS_DIR = getAdmiralHome();
const FLEETS_FILE = join(FLEETS_DIR, "fleets.json");

export class EngineServer {
  private httpServer: HttpServer;
  private wss: WebSocketServer;
  private processManager: ProcessManager;
  private shipManager: ShipManager;
  private flagshipManager: FlagshipManager;
  private dockManager: DockManager;
  private statusManager: StatusManager;
  private stateSync: StateSync;
  private requestHandler: FlagshipRequestHandler;
  private escortManager: EscortManager;
  private actorManager: ShipActorManager;
  private dispatchManager: DispatchManager;
  private lookout: Lookout;
  private clients = new Set<WebSocket>();
  private launchingCommanders = new Set<string>();
  private commanderFirstData = new Set<string>();
  private questionTimeoutTimer: ReturnType<typeof setInterval> | null = null;
  private processLivenessTimer: ReturnType<typeof setInterval> | null = null;
  private fleetDb: FleetDatabase | null = null;

  /** Unanswered commander questions auto-answered after this duration (ms). */
  private static readonly QUESTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  constructor(port: number) {
    this.processManager = new ProcessManager();
    this.statusManager = new StatusManager();
    this.shipManager = new ShipManager(
      this.processManager,
      this.statusManager,
    );
    this.flagshipManager = new FlagshipManager(this.processManager);
    this.dockManager = new DockManager(this.processManager);
    this.stateSync = new StateSync(this.shipManager, this.statusManager);
    this.requestHandler = new FlagshipRequestHandler(this.shipManager, this.stateSync);
    this.escortManager = new EscortManager(this.processManager, this.shipManager, () => this.fleetDb);
    this.actorManager = new ShipActorManager();
    this.dispatchManager = new DispatchManager(this.processManager);
    this.lookout = new Lookout(this.shipManager, this.processManager, this.escortManager);

    // Wire up ShipActorManager to ShipManager, EscortManager, and StateSync
    this.shipManager.setActorManager(this.actorManager);
    this.escortManager.setActorManager(this.actorManager);
    this.stateSync.setActorManager(this.actorManager);
    this.stateSync.setEscortManager(this.escortManager);

    // Configure Actor side effects
    this.actorManager.setSideEffects({
      onPhaseChange: (shipId, phase, detail) => {
        // Actor-driven phase changes are informational — DB updates are
        // handled after XState validates (db.persistPhaseTransition / ship-manager.updatePhase).
        console.log(`[actor] Ship ${shipId.slice(0, 8)}... phase: ${phase}${detail ? ` (${detail})` : ""}`);
      },
      onRecordTransition: (shipId, fromPhase, toPhase, triggeredBy, _metadata) => {
        console.log(`[actor] Ship ${shipId.slice(0, 8)}... transition: ${fromPhase} → ${toPhase} by ${triggeredBy}`);
      },
      onLaunchEscort: (shipId, gatePhase, gateType) => {
        // Escort launch is already handled by the API server / ship-manager flow.
        // The Actor entry action is informational for now.
        console.log(`[actor] Ship ${shipId.slice(0, 8)}... gate entry: ${gatePhase} (${gateType})`);
      },
    });

    // Dispatch completion handler: notify parent Commander via stdin + broadcast
    this.dispatchManager.setOnCompleteHandler((dispatch) => {
      const commanderId = `${dispatch.parentRole}-${dispatch.fleetId}`;
      const statusLabel = dispatch.status === "completed" ? "completed" : "failed";
      const summary = dispatch.result
        ? `[Dispatch ${statusLabel}] "${dispatch.name}": ${dispatch.result.slice(0, 2000)}`
        : `[Dispatch ${statusLabel}] "${dispatch.name}"`;

      // Send result to Commander stdin if running
      if (this.processManager.isRunning(commanderId)) {
        this.processManager.sendMessage(commanderId, summary);
      }

      // Inject into Commander chat history
      const manager: CommanderManager = dispatch.parentRole === "flagship"
        ? this.flagshipManager
        : this.dockManager;
      const statusMessage: StreamMessage = {
        type: "system",
        subtype: "dispatch-log",
        content: summary,
        timestamp: Date.now(),
      };
      manager.addToHistory(dispatch.fleetId, statusMessage);
      this.broadcast({
        type: `${dispatch.parentRole}:stream`,
        data: { fleetId: dispatch.fleetId, message: statusMessage },
      });

      // Broadcast dispatch:completed event
      this.broadcast({
        type: "dispatch:completed",
        data: {
          fleetId: dispatch.fleetId,
          dispatch: this.dispatchManager.toDispatch(dispatch),
        },
      });
    });

    // HTTP server handles REST API requests; WebSocket upgrades are routed to wss
    const apiHandler = createApiHandler({
      requestHandler: this.requestHandler,
      getDatabase: () => this.fleetDb,
      getShipManager: () => this.shipManager,
      getDispatchManager: () => this.dispatchManager,
      getEscortManager: () => this.escortManager,
      getActorManager: () => this.actorManager,
      getCommanderHistory: (role, fleetId) => {
        const manager: CommanderManager = role === "flagship" ? this.flagshipManager : this.dockManager;
        return manager.getHistoryWithDiskFallback(fleetId);
      },
      loadFleets: () => this.loadFleets(),
      loadRules: (paths) => this.loadRules(paths),
      requestRestart: () => {
        console.log("[engine] Restart requested via API");
        this.broadcast({ type: "engine:restarting", data: {} });
        // Write restart marker so the dev-runner knows to restart
        try {
          const markerPath = join(import.meta.dirname, "..", "..", ".restart");
          writeFileSync(markerPath, String(Date.now()));
        } catch (err) {
          console.warn("[engine] Failed to write .restart marker:", err);
        }
        this.shutdown();
        process.exit(0);
      },
      broadcastRequestResult: (fleetId, result) => {
        const resultMessage: StreamMessage = {
          type: "system",
          subtype: "request-result",
          content: result,
          timestamp: Date.now(),
        };
        this.flagshipManager.addToHistory(fleetId, resultMessage);
        this.broadcast({
          type: "flagship:stream",
          data: { fleetId, message: resultMessage },
        });
      },
    });

    this.httpServer = createServer(apiHandler);
    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on("upgrade", (request, socket, head) => {
      socket.on("error", (err) => {
        console.warn("[engine] Upgrade socket error:", err);
      });
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit("connection", ws, request);
      });
    });

    this.httpServer.on("error", (err) => {
      console.error("[engine] HTTP server error:", err);
    });

    this.httpServer.listen(port);

    this.setupWSS();
    this.setupProcessEvents();
    this.setupShipStatusHandler();
    this.setupShipCreatedHandler();
    this.runStartupReconciliation();
    this.startQuestionTimeoutScanner();
    this.setupLookout();
    this.startProcessLivenessCheck();

    console.log(`Engine HTTP+WebSocket server running on port ${port}`);

    // Notify frontend if this is a restart (dev-runner sets RESTARTED=1)
    if (process.env.RESTARTED === "1") {
      console.log("[engine] Restart detected — notifying frontend");
      // Delay broadcast to allow WebSocket clients to reconnect
      setTimeout(() => {
        this.broadcast({ type: "engine:restarted", data: {} });
      }, 2000);
    }
  }

  private setupWSS(): void {
    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      console.log("Client connected");

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as ClientMessage;
          this.handleMessage(ws, msg);
        } catch (err) {
          this.sendTo(ws, {
            type: "error",
            data: { source: "ws", message: `Invalid message: ${err}` },
          });
        }
      });

      ws.on("close", () => {
        this.clients.delete(ws);
        console.log("Client disconnected");
      });

      ws.on("error", (err) => {
        console.warn("[engine] WebSocket client error:", err);
        this.clients.delete(ws);
      });
    });
  }

  /** Resolve a commander manager by process ID prefix. */
  private resolveCommander(id: string): { role: CommanderRole; manager: CommanderManager; fleetId: string } | null {
    if (id.startsWith("flagship-")) {
      return { role: "flagship", manager: this.flagshipManager, fleetId: id.replace("flagship-", "") };
    }
    if (id.startsWith("dock-")) {
      return { role: "dock", manager: this.dockManager, fleetId: id.replace("dock-", "") };
    }
    return null;
  }

  /** Check if a process ID belongs to a commander (Dock or Flagship). */
  private isCommanderProcess(id: string): boolean {
    return id.startsWith("flagship-") || id.startsWith("dock-");
  }

  private setupProcessEvents(): void {
    this.processManager.on("data", (id: string, msg: Record<string, unknown>) => {
      // Route Dispatch stream data to frontend (independent process)
      if (this.dispatchManager.isDispatchProcess(id)) {
        const dispatch = this.dispatchManager.getDispatch(id);
        if (!dispatch) return;

        const parsed = parseStreamMessage(msg);
        if (parsed) {
          // Capture result text for completion notification
          if (parsed.type === "result" && parsed.content) {
            this.dispatchManager.setResult(id, parsed.content);
          }
          // Stream all non-result messages to frontend
          if (parsed.type !== "result") {
            this.broadcast({
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
      if (this.escortManager.isEscortProcess(id)) {
        const parentShipId = this.escortManager.findShipIdByEscortId(id);
        if (parentShipId) {
          const parentShip = this.shipManager.getShip(parentShipId);
          const parsed = parseStreamMessage(msg);

          // Extract sessionId from Escort init messages and persist to escorts table
          const sessionId = extractSessionId(msg);
          if (sessionId) {
            this.escortManager.setEscortSessionId(id, sessionId);
          }

          if (parsed && parsed.type !== "result") {
            // Mark assistant messages with escort-log metadata for visual distinction
            if (parsed.type === "assistant") {
              parsed.meta = {
                ...parsed.meta,
                category: "escort-log",
              };
            }
            this.broadcast({
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
      const commander = this.resolveCommander(id);
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
        if (!this.commanderFirstData.has(id)) {
          this.commanderFirstData.add(id);
          const pid = this.processManager.getPid(id);
          const roleLabel = role === "flagship" ? "Flagship" : "Dock";
          const connMsg = {
            type: "system" as const,
            subtype: "commander-status" as const,
            content: `${roleLabel} CLI connected${pid ? ` (pid: ${pid})` : ""}`,
            timestamp: Date.now(),
          };
          manager.addToHistory(fleetId, connMsg);
          this.broadcast({
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
            this.broadcast({
              type: questionType,
              data: { fleetId, message: questionMessage },
            });
          } else if (parsed.type !== "result") {
            manager.addToHistory(fleetId, parsed);
            this.broadcast({
              type: streamType,
              data: { fleetId, message: parsed },
            });
          }
        }
      } else {
        // Update lastOutputAt for Lookout no-output detection
        this.shipManager.setLastOutputAt(id, Date.now());

        // Extract sessionId from init messages (before parsing drops them)
        const sessionId = extractSessionId(msg);
        if (sessionId) {
          const ship = this.shipManager.getShip(id);
          if (ship && !ship.sessionId) {
            this.shipManager.setSessionId(id, sessionId);
            console.log(
              `[ws-server] Ship ${id.slice(0, 8)}... sessionId captured: ${sessionId.slice(0, 12)}...`,
            );
          }
        }

        // Detect compact status changes from raw message (before parsing)
        this.detectCompactStatus(id, msg);

        // Ship stream — parse raw CLI JSON before broadcast
        const parsed = parseStreamMessage(msg);
        if (parsed) {
          // Detect PR URL in assistant/result messages (before filtering)
          this.detectPRCreation(id, parsed);

          // Skip result messages — they duplicate the last assistant message
          if (parsed.type !== "result") {
            this.logShipMessage(id, parsed);
            this.broadcast({
              type: "ship:stream",
              data: { id, message: parsed },
            });
          }
        }
      }
    });

    this.processManager.on("exit", (id: string, code: number | null) => {
      // Handle Dispatch process exit
      if (this.dispatchManager.isDispatchProcess(id)) {
        console.log(`[ws-server] Dispatch ${id.slice(0, 16)}... exited (code=${code})`);
        this.dispatchManager.onProcessExit(id, code);
        return;
      }

      // Handle Escort-Ship process exit
      if (this.escortManager.isEscortProcess(id)) {
        const parentShipId = this.escortManager.findShipIdByEscortId(id);
        this.escortManager.onEscortExit(id, code);
        if (parentShipId) {
          const parentShip = this.shipManager.getShip(parentShipId);
          this.broadcast({
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
                issueNumber: parentShip.issueNumber,
                issueTitle: parentShip.issueTitle,
              },
              timestamp: Date.now(),
            };
            this.flagshipManager.addToHistory(parentShip.fleetId, escortMsg);
            this.broadcast({
              type: "flagship:stream",
              data: { fleetId: parentShip.fleetId, message: escortMsg },
            });
          }
        }
        return;
      }

      const exitCommander = this.resolveCommander(id);
      if (exitCommander) {
        this.commanderFirstData.delete(id);
        const { role, fleetId } = exitCommander;
        const roleLabel = role === "flagship" ? "Flagship" : "Dock";
        console.log(`${roleLabel} ${id} exited with code ${code}`);
        this.broadcast({
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
        const ship = this.shipManager.getShip(id);
        if (!ship) {
          console.warn(`[ws-server] Ship ${id} exited but is not tracked — skipping cleanup`);
          return;
        }
        // Ship declares "done" via direct DB phase update.
        // If the process exits while in "done" phase, treat as success.
        // If in "merging" phase (squash merge may kill the process), also treat as success.
        const successPhases = new Set(["done", "merging", "stopped"]);
        if (successPhases.has(ship.phase)) {
          this.stateSync.onProcessExit(id, true).catch(console.error);
        } else {
          // Process exited without declaring done — treat as failure.
          this.stateSync.onProcessExit(id, false).catch(console.error);
        }
      }
    });

    this.processManager.on("rate-limit", (id: string) => {
      if (this.isCommanderProcess(id)) {
        console.warn(`[ws-server] Commander ${id} hit rate limit`);
        return;
      }
      console.warn(
        `[ws-server] Ship ${id.slice(0, 8)}... hit rate limit — backoff will apply on next retry`,
      );
      this.shipManager.setLastRateLimitAt(id, Date.now());
    });

    this.processManager.on("error", (id: string, error: Error) => {
      console.error(`Process ${id} error:`, error.message);
      const errCommander = this.resolveCommander(id);
      if (errCommander) {
        const { role, manager, fleetId } = errCommander;
        const hadData = this.commanderFirstData.has(id);
        this.commanderFirstData.delete(id);
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
          this.broadcast({
            type: `${role}:stream`,
            data: { fleetId, message: errMsg },
          });
        }
      }
      this.broadcast({
        type: "error",
        data: { source: id, message: error.message },
      });
    });
  }

  private setupShipStatusHandler(): void {
    this.shipManager.setPhaseChangeHandler((id, phase, detail) => {
      const ship = this.shipManager.getShip(id);

      // Event Notification pattern: send minimal notification, Frontend fetches via REST API
      if (phase === "done") {
        this.broadcast({ type: "ship:done", data: { shipId: id } });
      } else {
        this.broadcast({ type: "ship:updated", data: { shipId: id } });
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
            issueNumber: ship.issueNumber,
            issueTitle: ship.issueTitle,
          },
          timestamp: Date.now(),
        };
        this.flagshipManager.addToHistory(ship.fleetId, statusMessage);
        this.broadcast({
          type: "flagship:stream",
          data: { fleetId: ship.fleetId, message: statusMessage },
        });

        // Send phase change to Flagship stdin if Flagship is running
        const flagshipId = `flagship-${ship.fleetId}`;
        if (this.processManager.isRunning(flagshipId)) {
          this.processManager.sendMessage(
            flagshipId,
            statusMessage.content,
          );
        }
      }
    });
  }

  private setupShipCreatedHandler(): void {
    this.shipManager.setShipCreatedHandler((id) => {
      this.broadcast({ type: "ship:created", data: { shipId: id } });
    });
  }

  private setupLookout(): void {
    this.lookout.setAlertHandler((alert: LookoutAlert) => {
      const ship = this.shipManager.getShip(alert.shipId);
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
      this.flagshipManager.addToHistory(alert.fleetId, alertMessage);
      this.broadcast({
        type: "flagship:stream",
        data: { fleetId: alert.fleetId, message: alertMessage },
      });

      // Send to Flagship stdin if Flagship is running
      if (this.processManager.isRunning(flagshipId)) {
        this.processManager.sendMessage(
          flagshipId,
          `[Lookout Alert] ${alert.message}`,
        );
      }
    });

    this.lookout.start();

    // Escort death notifications → Flagship chat
    this.escortManager.setEscortDeathHandler((shipId, message) => {
      const ship = this.shipManager.getShip(shipId);
      if (!ship) return;

      const deathMsg: StreamMessage = {
        type: "system",
        subtype: "ship-status",
        content: `[Escort Death] ${message}`,
        meta: {
          category: "ship-status",
          issueNumber: ship.issueNumber,
          issueTitle: ship.issueTitle,
        },
        timestamp: Date.now(),
      };
      this.flagshipManager.addToHistory(ship.fleetId, deathMsg);
      this.broadcast({
        type: "flagship:stream",
        data: { fleetId: ship.fleetId, message: deathMsg },
      });

      const flagshipId = `flagship-${ship.fleetId}`;
      if (this.processManager.isRunning(flagshipId)) {
        this.processManager.sendMessage(flagshipId, `[Escort Death] ${message}`);
      }
    });
  }

  private async handleMessage(
    ws: WebSocket,
    msg: ClientMessage,
  ): Promise<void> {
    const data = msg.data ?? {};

    try {
      switch (msg.type) {
        // Fleet operations
        case "fleet:create": {
          const newFleet = await this.createFleet(
            data.name as string,
            data.repos as FleetRepo[],
          );
          const fleets = await this.loadFleets();
          this.sendTo(ws, {
            type: "fleet:created",
            data: { id: newFleet.id, fleets },
          });
          break;
        }
        case "fleet:list": {
          const fleets = await this.loadFleets();
          this.sendTo(ws, { type: "fleet:data", data: fleets });
          break;
        }
        case "fleet:select": {
          const fleets = await this.loadFleets();
          this.sendTo(ws, { type: "fleet:data", data: fleets });
          break;
        }
        case "fleet:update": {
          await this.updateFleet(data.id as string, data);
          const fleets = await this.loadFleets();
          this.sendTo(ws, { type: "fleet:data", data: fleets });
          break;
        }
        case "fleet:delete": {
          await this.deleteFleet(data.id as string);
          const fleets = await this.loadFleets();
          this.sendTo(ws, { type: "fleet:data", data: fleets });
          break;
        }

        // Flagship operations
        case "flagship:send": {
          await this.handleCommanderSend(ws, data, "flagship");
          break;
        }
        case "flagship:answer": {
          this.handleCommanderAnswer(data, "flagship");
          break;
        }
        case "flagship:history": {
          await this.handleCommanderHistory(ws, data, "flagship");
          break;
        }

        // Dock operations
        case "dock:send": {
          await this.handleCommanderSend(ws, data, "dock");
          break;
        }
        case "dock:answer": {
          this.handleCommanderAnswer(data, "dock");
          break;
        }
        case "dock:history": {
          await this.handleCommanderHistory(ws, data, "dock");
          break;
        }

        // Ship operations (sortie/stop/retry/list moved to REST API — see api-server.ts)
        case "ship:chat": {
          const ship = this.shipManager.getShip(data.id as string);
          if (ship?.sessionId) {
            this.processManager.resumeSession(
              data.id as string,
              ship.sessionId,
              data.message as string,
              ship.worktreePath,
            );
          }
          break;
        }
        case "ship:logs": {
          const shipId = data.id as string;
          const limit = data.limit as number | undefined;
          const logs = await this.shipManager.loadShipLogs(shipId, limit);
          this.sendTo(ws, {
            type: "ship:history",
            data: { id: shipId, messages: logs },
          });
          break;
        }

        // Issue operations (deterministic - no LLM)
        case "issue:list": {
          const issues = await github.listIssues(data.repo as string);
          this.sendTo(ws, {
            type: "issue:data",
            data: { repo: data.repo as string, issues },
          });
          break;
        }
        case "issue:get": {
          const issue = await github.getIssue(
            data.repo as string,
            data.number as number,
          );
          this.sendTo(ws, {
            type: "issue:data",
            data: { repo: data.repo as string, issues: [issue] },
          });
          break;
        }

        // Filesystem operations (localhost-only; returns dir names, no file content)
        case "fs:list-dir": {
          const dirPath = (data.path as string) || homedir();
          const resolved = await realpath(resolve(dirPath));
          const s = await stat(resolved);
          if (!s.isDirectory()) {
            throw new Error(`Not a directory: "${resolved}"`);
          }
          const dirents = await readdir(resolved, { withFileTypes: true });
          const entries = dirents
            .filter((d) => !d.name.startsWith("."))
            .map((d) => ({ name: d.name, isDirectory: d.isDirectory() }))
            .sort((a, b) => {
              if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
              return a.name.localeCompare(b.name);
            });
          this.sendTo(ws, {
            type: "fs:dir-listing",
            data: { path: resolved, entries },
          });
          break;
        }

        default:
          this.sendTo(ws, {
            type: "error",
            data: { source: "ws", message: `Unknown message type: ${msg.type}` },
          });
      }
    } catch (err) {
      this.sendTo(ws, {
        type: "error",
        data: {
          source: msg.type,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  // Fleet persistence
  private async loadFleets(): Promise<Fleet[]> {
    try {
      const content = await readFile(FLEETS_FILE, "utf-8");
      const parsed = JSON.parse(content) as Fleet[];
      let migrated = false;
      for (const fleet of parsed) {
        if (fleet.repos?.length > 0 && typeof fleet.repos[0] === "string") {
          fleet.repos = (fleet.repos as unknown as string[]).map((remote) => ({
            localPath: "",
            remote,
          }));
          migrated = true;
        }
      }
      if (migrated) {
        await this.saveFleets(parsed);
      }
      return parsed;
    } catch {
      return [];
    }
  }

  private async saveFleets(fleets: Fleet[]): Promise<void> {
    await mkdir(FLEETS_DIR, { recursive: true });
    await writeFile(FLEETS_FILE, JSON.stringify(fleets, null, 2));
  }

  private async resolveRemote(localPath: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync("git", [
        "remote",
        "get-url",
        "origin",
      ], { cwd: localPath });
      const url = stdout.trim();
      if (!url) return undefined;
      // Extract owner/repo from GitHub URL (handle trailing slashes)
      const match = url.match(/github\.com[:/](.+?)(?:\.git)?\/*$/);
      if (match) return match[1];
      // For non-GitHub remotes (GitLab, Bitbucket, etc.), return the full URL
      return url;
    } catch {
      return undefined;
    }
  }

  private async validateLocalPath(localPath: string): Promise<void> {
    if (!isAbsolute(localPath)) {
      throw new Error(`localPath must be absolute: "${localPath}"`);
    }
    const s = await stat(localPath).catch(() => null);
    if (!s?.isDirectory()) {
      throw new Error(`localPath is not a directory: "${localPath}"`);
    }
  }

  private async enrichRepos(repos: FleetRepo[]): Promise<FleetRepo[]> {
    return Promise.all(
      repos.map(async (repo) => {
        await this.validateLocalPath(repo.localPath);
        if (repo.remote) return repo;
        const remote = await this.resolveRemote(repo.localPath);
        return remote ? { ...repo, remote } : repo;
      }),
    );
  }

  private async createFleet(
    name: string,
    repos: FleetRepo[],
  ): Promise<Fleet> {
    const enriched = await this.enrichRepos(repos);
    const fleets = await this.loadFleets();
    const fleet: Fleet = {
      id: randomUUID(),
      name,
      repos: enriched,
      createdAt: new Date().toISOString(),
    };
    fleets.push(fleet);
    await this.saveFleets(fleets);
    return fleet;
  }

  private async updateFleet(
    id: string,
    updates: Record<string, unknown>,
  ): Promise<void> {
    const fleets = await this.loadFleets();
    const fleet = fleets.find((f) => f.id === id);
    if (!fleet) throw new Error(`Fleet not found: ${id}`);
    if (updates.name !== undefined) fleet.name = updates.name as string;
    if (updates.repos !== undefined) fleet.repos = await this.enrichRepos(updates.repos as FleetRepo[]);
    if (updates.skillSources !== undefined) fleet.skillSources = updates.skillSources as FleetSkillSources;
    if (updates.sharedRulePaths !== undefined) fleet.sharedRulePaths = updates.sharedRulePaths as string[];
    if (updates.flagshipRulePaths !== undefined) fleet.flagshipRulePaths = updates.flagshipRulePaths as string[];
    if (updates.dockRulePaths !== undefined) fleet.dockRulePaths = updates.dockRulePaths as string[];
    if (updates.shipRulePaths !== undefined) fleet.shipRulePaths = updates.shipRulePaths as string[];
    if (updates.customInstructions !== undefined) fleet.customInstructions = updates.customInstructions as CustomInstructions;
    if (updates.gates !== undefined) fleet.gates = updates.gates as FleetGateSettings;
    if (updates.gatePrompts !== undefined) fleet.gatePrompts = updates.gatePrompts as Partial<Record<GateType, string>>;
    if (updates.maxConcurrentSorties !== undefined) fleet.maxConcurrentSorties = updates.maxConcurrentSorties as number;
    await this.saveFleets(fleets);
  }

  private async deleteFleet(id: string): Promise<void> {
    let fleets = await this.loadFleets();
    fleets = fleets.filter((f) => f.id !== id);
    await this.saveFleets(fleets);
    this.flagshipManager.stop(id);
    this.dockManager.stop(id);
  }

  // Messaging helpers
  private sendTo(ws: WebSocket, msg: Record<string, unknown>): void {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(msg));
      } catch (err) {
        console.warn("[engine] sendTo failed:", err);
      }
    }
  }

  private broadcast(msg: Record<string, unknown>): void {
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) {
        try {
          client.send(data);
        } catch (err) {
          console.warn("[engine] broadcast send failed:", err);
        }
      }
    }
  }

  private async handleCommanderSend(
    ws: WebSocket,
    data: Record<string, unknown>,
    role: CommanderRole,
  ): Promise<void> {
    const manager = role === "flagship" ? this.flagshipManager : this.dockManager;
    const fleetId = data.fleetId as string;
    const message = data.message as string;

    // Guard: reject if a question is pending
    const pending = manager.getPendingQuestion(fleetId);
    if (pending) {
      this.sendTo(ws, {
        type: "error",
        data: {
          source: `${role}:send`,
          message: "Cannot send a command while a question is pending. Please answer the question first.",
        },
      });
      return;
    }

    const rawImages = data.images as Array<{ base64: string; mediaType: string }> | undefined;
    const ALLOWED_MEDIA = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
    const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
    const MAX_IMAGES = 10;
    const images = rawImages
      ?.filter((img) => ALLOWED_MEDIA.has(img.mediaType) && img.base64.length <= MAX_IMAGE_SIZE)
      .slice(0, MAX_IMAGES);

    const launchKey = `${role}-${fleetId}`;
    if (
      !manager.hasSession(fleetId) &&
      !this.launchingCommanders.has(launchKey)
    ) {
      this.launchingCommanders.add(launchKey);
      try {
        const fleets = await this.loadFleets();
        const fleet = fleets.find((f) => f.id === fleetId);
        if (!fleet) {
          throw new Error(`Fleet not found: ${fleetId}`);
        }
        const remoteNames = fleet.repos
          .map((r) => r.remote)
          .filter((r): r is string => r !== undefined);

        let prompt: string;
        let roleRules: string;
        if (role === "flagship") {
          prompt = buildFlagshipSystemPrompt(
            fleet.name,
            remoteNames,
            fleet.maxConcurrentSorties ?? 6,
          );
          roleRules = await this.loadRules(fleet.flagshipRulePaths ?? fleet.bridgeRulePaths ?? []);
        } else {
          prompt = buildDockSystemPrompt(fleet.name, remoteNames);
          roleRules = await this.loadRules(fleet.dockRulePaths ?? []);
        }

        const sharedRules = await this.loadRules(fleet.sharedRulePaths ?? []);
        const rulesSuffix = [sharedRules, roleRules].filter(Boolean).join("\n\n");
        if (rulesSuffix) {
          prompt = `${prompt}\n\n## Additional Rules\n\n${rulesSuffix}`;
        }

        const ci = fleet.customInstructions;
        const ciParts = [ci?.shared, role === "flagship" ? ci?.flagship : ci?.dock].filter(Boolean);
        if (ciParts.length > 0) {
          prompt = `${prompt}\n\n## Custom Instructions\n\n${ciParts.join("\n\n")}`;
        }

        await manager.launch(
          fleetId,
          process.cwd(),
          [],
          prompt,
        );

        const roleLabel = role === "flagship" ? "Flagship" : "Dock";
        const startMsg = {
          type: "system" as const,
          subtype: "commander-status" as const,
          content: `Starting ${roleLabel} session...`,
          timestamp: Date.now(),
        };
        manager.addToHistory(fleetId, startMsg);
        this.broadcast({
          type: `${role}:stream`,
          data: { fleetId, message: startMsg },
        });
      } finally {
        this.launchingCommanders.delete(launchKey);
      }
    }
    manager.send(fleetId, message, images);
  }

  private handleCommanderAnswer(
    data: Record<string, unknown>,
    role: CommanderRole,
  ): void {
    const manager = role === "flagship" ? this.flagshipManager : this.dockManager;
    const fleetId = data.fleetId as string;
    const answer = data.answer as string;
    const toolUseId = data.toolUseId as string | undefined;
    const processId = `${role}-${fleetId}`;

    manager.clearPendingQuestion(fleetId);

    const answerMessage: StreamMessage = {
      type: "user",
      content: answer,
    };
    manager.addToHistory(fleetId, answerMessage);

    if (toolUseId) {
      this.processManager.sendToolResult(processId, toolUseId, answer);
    } else {
      this.processManager.sendMessage(processId, answer);
    }
  }

  private async handleCommanderHistory(
    ws: WebSocket,
    data: Record<string, unknown>,
    role: CommanderRole,
  ): Promise<void> {
    const manager = role === "flagship" ? this.flagshipManager : this.dockManager;
    const fleetId = data.fleetId as string;
    // Use disk fallback so history is available even after Engine restart
    // (before the Commander process is re-launched by a user message).
    const history = await manager.getHistoryWithDiskFallback(fleetId);
    this.sendTo(ws, {
      type: `${role}:stream`,
      data: {
        fleetId,
        message: { type: "history", content: JSON.stringify(history) },
      },
    });
  }

  private runStartupReconciliation(): void {
    this.initDatabase()
      .then(() => this.loadFleets())
      .then((fleets) => {
        const allRepos = fleets.flatMap((f) => f.repos);
        return this.stateSync.reconcileOnStartup(allRepos);
      })
      .catch((err) => {
        if (!this.fleetDb) {
          // DB init failed — fatal, Engine cannot operate without a database
          console.error("[engine] Database initialization failed, shutting down:", err);
          this.shutdown();
          process.exit(1);
        }
        // Non-DB errors (fleet loading, reconciliation) are non-fatal
        console.warn("[engine] Startup reconciliation failed:", err);
      });
  }

  private async initDatabase(): Promise<void> {
    try {
      const admiralHome = getAdmiralHome();
      const dbPath = join(admiralHome, "fleet.db");
      console.log(`[engine] Opening fleet database at: ${dbPath}`);

      this.fleetDb = await initFleetDatabase(admiralHome);
      this.shipManager.setDatabase(this.fleetDb);

      // Verify DB path consistency: warn if ADMIRAL_HOME changed since last run
      await this.checkDbPathConsistency(admiralHome);

      console.log("[engine] Fleet database initialized");
    } catch (err) {
      console.error("[engine] Failed to initialize fleet database:", err);
      throw err;
    }
  }

  /**
   * Check if the DB path matches the one used in the previous run.
   * Warns if ADMIRAL_HOME changed, which would create a new empty DB.
   */
  private async checkDbPathConsistency(currentHome: string): Promise<void> {
    const markerPath = join(currentHome, ".db-home-marker");
    try {
      const previousHome = await readFile(markerPath, "utf-8").catch(() => null);
      if (previousHome !== null && previousHome.trim() !== currentHome) {
        console.warn(
          `[engine] WARNING: ADMIRAL_HOME changed from "${previousHome.trim()}" to "${currentHome}". ` +
          `Ship data from the previous path may be inaccessible.`,
        );
      }
      await writeFile(markerPath, currentHome, "utf-8");
    } catch (err) {
      // Non-fatal: best-effort consistency tracking
      console.warn("[engine] Could not check DB path consistency:", err);
    }
  }

  private detectPRCreation(
    id: string,
    msg: StreamMessage,
  ): void {
    if (!msg.content) return;
    // Match GitHub PR URLs in assistant or result messages
    if (msg.type !== "assistant" && msg.type !== "result") return;

    const prUrlMatch = msg.content.match(
      /https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/,
    );
    if (!prUrlMatch) return;

    const ship = this.shipManager.getShip(id);
    if (!ship || ship.prUrl) return; // Already detected

    const prUrl = prUrlMatch[0];

    // Store PR URL on ship (DB + runtime)
    this.shipManager.setPrUrl(id, prUrl);

    // Broadcast PR detection as ship:updated notification — Frontend fetches via REST API
    this.broadcast({ type: "ship:updated", data: { shipId: id } });
  }

  private detectCompactStatus(
    id: string,
    raw: Record<string, unknown>,
  ): void {
    // Detect SDKStatusMessage: { type: "system", subtype: "status", status: "compacting" | null }
    if (raw.type !== "system" || raw.subtype !== "status") return;

    const status = raw.status as string | null | undefined;
    // Only handle compact-related status changes
    if (status !== "compacting" && status !== null && status !== undefined) return;
    const isCompacting = status === "compacting";
    const ship = this.shipManager.getShip(id);
    if (!ship) return;

    this.shipManager.setIsCompacting(id, isCompacting);
    this.broadcast({
      type: "ship:compacting",
      data: { id, isCompacting },
    });

    // Also inject into Flagship chat (Ship management is Flagship's domain)
    if (isCompacting) {
      const compactMsg = {
        type: "system" as const,
        subtype: "ship-status" as const,
        content: `Ship #${ship.issueNumber} (${ship.issueTitle}): compacting context...`,
        timestamp: Date.now(),
      };
      this.flagshipManager.addToHistory(ship.fleetId, compactMsg);
      this.broadcast({
        type: "flagship:stream",
        data: { fleetId: ship.fleetId, message: compactMsg },
      });
    }
  }

  private logShipMessage(
    id: string,
    msg: StreamMessage,
  ): void {
    const ship = this.shipManager.getShip(id);
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

  private async loadRules(paths: string[]): Promise<string> {
    if (!paths || paths.length === 0) return "";
    const parts: string[] = [];
    for (const p of paths) {
      try {
        const content = await readFile(p, "utf-8");
        parts.push(content.trim());
      } catch {
        console.warn(`[engine] Failed to read rule file: ${p}`);
      }
    }
    return parts.join("\n\n");
  }

  private startQuestionTimeoutScanner(): void {
    this.questionTimeoutTimer = setInterval(() => {
      this.scanQuestionTimeouts();
    }, 30_000);
    this.questionTimeoutTimer.unref();
  }

  private scanQuestionTimeouts(): void {
    const now = Date.now();
    const managers: Array<{ role: CommanderRole; manager: CommanderManager }> = [
      { role: "flagship", manager: this.flagshipManager },
      { role: "dock", manager: this.dockManager },
    ];

    for (const { role, manager } of managers) {
      const pending = manager.getSessionsWithPendingQuestion();

      for (const { fleetId, toolUseId, askedAt } of pending) {
        if (now - askedAt <= EngineServer.QUESTION_TIMEOUT_MS) continue;

        const roleLabel = role === "flagship" ? "Flagship" : "Dock";
        console.warn(
          `[ws-server] ${roleLabel} question for fleet ${fleetId} timed out after ${EngineServer.QUESTION_TIMEOUT_MS / 1000}s. Auto-answering.`,
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
        this.broadcast({
          type: `${role}:stream`,
          data: { fleetId, message: answerMsg },
        });
        this.broadcast({
          type: `${role}:stream`,
          data: { fleetId, message: timeoutMsg },
        });

        // Clear pendingQuestion on frontend
        this.broadcast({
          type: `${role}:question-timeout`,
          data: { fleetId },
        });

        // Send tool_result to commander stdin
        this.processManager.sendToolResult(processId, toolUseId, autoAnswer);
      }
    }
  }

  private startProcessLivenessCheck(): void {
    this.processLivenessTimer = setInterval(() => {
      for (const ship of this.shipManager.getAllShips()) {
        if (ship.phase !== "done" && ship.phase !== "stopped" && !this.processManager.isRunning(ship.id)) {
          if (!ship.processDead) {
            this.shipManager.notifyProcessDead(ship.id);
          }
        }
      }
    }, 30_000);
    this.processLivenessTimer.unref();
  }

  shutdown(): void {
    if (this.questionTimeoutTimer) {
      clearInterval(this.questionTimeoutTimer);
      this.questionTimeoutTimer = null;
    }
    if (this.processLivenessTimer) {
      clearInterval(this.processLivenessTimer);
      this.processLivenessTimer = null;
    }
    this.dispatchManager.killAll();
    this.escortManager.killAll();
    this.actorManager.stopAll();
    this.shipManager.stopAll();
    this.flagshipManager.stopAll();
    this.dockManager.stopAll();
    this.processManager.killAll();
    this.fleetDb?.close();
    this.wss.close();
    this.httpServer.close();
  }
}
