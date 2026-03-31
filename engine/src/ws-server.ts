/**
 * Engine WebSocket server — thin orchestrator.
 * Delegates to focused modules: api-handlers, ship-lifecycle, startup, health-monitor.
 * See ADR-0016 for the rationale behind this module split.
 */
import { WebSocketServer, type WebSocket } from "ws";
import { createServer, type Server as HttpServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { ProcessManager } from "./process-manager.js";
import { ShipManager } from "./ship-manager.js";
import { FlagshipManager } from "./flagship.js";
import { DockManager } from "./dock.js";
import type { CommanderManager } from "./commander.js";
import { StatusManager } from "./status-manager.js";
import { StateSync } from "./state-sync.js";
import { FlagshipRequestHandler } from "./bridge-request-handler.js";
import { EscortManager } from "./escort-manager.js";
import { ShipActorManager } from "./ship-actor-manager.js";
import { DispatchManager } from "./dispatch-manager.js";
import { CaffeinateManager } from "./caffeinate-manager.js";
import type { FleetDatabase } from "./db.js";
import { createApiHandler } from "./api-server.js";
import { Lookout } from "./lookout.js";
import type { ClientMessage, StreamMessage, HeadsUpNotification, ResumeAllUnitResult, ServerMessage } from "./types.js";
import { readLastCrashLog, clearCrashLog } from "./crash-logger.js";
import type { CrashLog } from "./crash-logger.js";

// Module imports (ADR-0016 Phase 1)
import { loadFleets, loadAdmiralSettings, loadRules, handleMessage, type MessageHandlerDeps } from "./api-handlers.js";
import { setupProcessEvents, setupShipStatusHandler, setupShipCreatedHandler, setupLookout, deliverHeadsUp } from "./ship-lifecycle.js";
import { runStartupReconciliation } from "./startup.js";
import { startQuestionTimeoutScanner, startProcessLivenessCheck, startHeartbeat, resumeAllUnits } from "./health-monitor.js";

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
  private caffeinateManager: CaffeinateManager;
  private clients = new Set<WebSocket>();
  private launchingCommanders = new Set<string>();
  private commanderFirstData = new Set<string>();
  private questionTimeoutTimer: ReturnType<typeof setInterval> | null = null;
  private processLivenessTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private clientAliveMap = new WeakMap<WebSocket, boolean>();
  private fleetDb: FleetDatabase | null = null;
  private pendingCrashLog: CrashLog | null = null;

  /** Unanswered commander questions auto-answered after this duration (ms). */
  private static readonly QUESTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  /** Interval between WS heartbeat pings (ms). */
  private static readonly HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds

  /** Deps object for message handler (created once, reused). */
  private messageHandlerDeps: MessageHandlerDeps;

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

    // CaffeinateManager: default enabled; overridden by persisted settings in runStartupReconciliation()
    this.caffeinateManager = new CaffeinateManager(true);
    this.caffeinateManager.setOnStatusChange((status) => {
      this.broadcast({ type: "caffeinate:status", data: status });
    });

    // Wire up ShipActorManager to ShipManager, EscortManager, and StateSync
    this.shipManager.setActorManager(this.actorManager);
    this.escortManager.setActorManager(this.actorManager);
    this.stateSync.setActorManager(this.actorManager);
    this.stateSync.setEscortManager(this.escortManager);

    // Configure Actor side effects
    this.actorManager.setSideEffects({
      onPhaseChange: (shipId, phase, detail) => {
        console.log(`[actor] Ship ${shipId.slice(0, 8)}... phase: ${phase}${detail ? ` (${detail})` : ""}`);
      },
      onRecordTransition: (shipId, fromPhase, toPhase, triggeredBy, _metadata) => {
        console.log(`[actor] Ship ${shipId.slice(0, 8)}... transition: ${fromPhase} → ${toPhase} by ${triggeredBy}`);
      },
      onLaunchEscort: (shipId, gatePhase, gateType) => {
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

    // Create message handler deps (reused for all WS messages)
    this.messageHandlerDeps = {
      shipManager: this.shipManager,
      processManager: this.processManager,
      flagshipManager: this.flagshipManager,
      dockManager: this.dockManager,
      caffeinateManager: this.caffeinateManager,
      launchingCommanders: this.launchingCommanders,
      broadcast: (msg: ServerMessage) => this.broadcast(msg),
      sendTo: (ws: WebSocket, msg: ServerMessage) => this.sendTo(ws, msg),
    };

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
      loadFleets: () => loadFleets(),
      loadRules: (paths) => loadRules(paths),
      loadAdmiralSettings: () => loadAdmiralSettings(),
      requestRestart: () => {
        console.log("[engine] Restart requested via API");
        this.broadcast({ type: "engine:restarting", data: {} });
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
      deliverHeadsUp: (notification: HeadsUpNotification) => {
        return deliverHeadsUp(
          {
            flagshipManager: this.flagshipManager,
            dockManager: this.dockManager,
            processManager: this.processManager,
            broadcast: (msg: ServerMessage) => this.broadcast(msg),
          },
          notification,
        );
      },
      resumeAllUnits: () => this.resumeAllUnits(),
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

    // Set up modules (ADR-0016 Phase 1)
    this.setupWSS();

    setupProcessEvents({
      processManager: this.processManager,
      shipManager: this.shipManager,
      flagshipManager: this.flagshipManager,
      dockManager: this.dockManager,
      stateSync: this.stateSync,
      escortManager: this.escortManager,
      dispatchManager: this.dispatchManager,
      lookout: this.lookout,
      commanderFirstData: this.commanderFirstData,
      broadcast: (msg: ServerMessage) => this.broadcast(msg),
      syncCaffeinateCount: () => this.syncCaffeinateCount(),
    });

    setupShipStatusHandler({
      shipManager: this.shipManager,
      flagshipManager: this.flagshipManager,
      processManager: this.processManager,
      broadcast: (msg: ServerMessage) => this.broadcast(msg),
    });

    setupShipCreatedHandler(
      this.shipManager,
      (msg: ServerMessage) => this.broadcast(msg),
    );

    runStartupReconciliation({
      shipManager: this.shipManager,
      stateSync: this.stateSync,
      caffeinateManager: this.caffeinateManager,
      setFleetDb: (db) => { this.fleetDb = db; },
      getFleetDb: () => this.fleetDb,
      loadAdmiralSettings: () => loadAdmiralSettings(),
      loadFleets: () => loadFleets(),
      shutdown: () => this.shutdown(),
      resumeAllUnits: () => this.resumeAllUnits(),
    });

    this.questionTimeoutTimer = startQuestionTimeoutScanner({
      flagshipManager: this.flagshipManager,
      dockManager: this.dockManager,
      processManager: this.processManager,
      broadcast: (msg: ServerMessage) => this.broadcast(msg),
      QUESTION_TIMEOUT_MS: EngineServer.QUESTION_TIMEOUT_MS,
    });

    setupLookout({
      shipManager: this.shipManager,
      flagshipManager: this.flagshipManager,
      processManager: this.processManager,
      escortManager: this.escortManager,
      lookout: this.lookout,
      broadcast: (msg: ServerMessage) => this.broadcast(msg),
    });

    this.processLivenessTimer = startProcessLivenessCheck({
      shipManager: this.shipManager,
      processManager: this.processManager,
    });

    this.heartbeatTimer = startHeartbeat({
      clients: this.clients,
      clientAliveMap: this.clientAliveMap,
      sendTo: (ws: WebSocket, msg: ServerMessage) => this.sendTo(ws, msg),
      HEARTBEAT_INTERVAL_MS: EngineServer.HEARTBEAT_INTERVAL_MS,
    });

    console.log(`Engine HTTP+WebSocket server running on port ${port}`);

    // Check for previous crash log and hold it for the first client connection
    this.pendingCrashLog = readLastCrashLog();
    if (this.pendingCrashLog) {
      console.log(`[engine] Previous crash detected at ${this.pendingCrashLog.timestamp}: ${this.pendingCrashLog.message}`);
      clearCrashLog();
    }

    // Notify frontend if this is a restart (dev-runner sets RESTARTED=1)
    if (process.env.RESTARTED === "1") {
      console.log("[engine] Restart detected — notifying frontend");
      // Delay broadcast to allow WebSocket clients to reconnect
      setTimeout(() => {
        this.broadcast({ type: "engine:restarted", data: {} });
      }, 2000);
    }
  }

  // ── WebSocket Connection Management ──

  private setupWSS(): void {
    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      this.clientAliveMap.set(ws, true);
      console.log("Client connected");

      ws.on("pong", () => {
        this.clientAliveMap.set(ws, true);
      });

      // Notify the first connecting client about a previous crash
      if (this.pendingCrashLog) {
        const crashData = this.pendingCrashLog;
        this.pendingCrashLog = null;
        this.sendTo(ws, {
          type: "engine:previous-crash",
          data: {
            timestamp: crashData.timestamp,
            context: crashData.context,
            message: crashData.message,
            stack: crashData.stack,
          },
        });
      }

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as ClientMessage;
          if (msg.type === "pong") {
            // Application-level pong response — mark client as alive
            this.clientAliveMap.set(ws, true);
            return;
          }
          handleMessage(this.messageHandlerDeps, ws, msg);
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

  // ── Messaging Primitives ──

  private sendTo(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(msg));
      } catch (err) {
        console.warn("[engine] sendTo failed:", err);
      }
    }
  }

  /**
   * Type-safe broadcast: sends a ServerMessage to all connected WebSocket clients.
   * The discriminated union ensures payload shape matches the message type.
   */
  private broadcast(msg: ServerMessage): void {
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

  // ── Caffeinate Sync ──

  private syncCaffeinateCount(): void {
    this.caffeinateManager.updateActiveUnitCount(this.processManager.getActiveCount());
  }

  // ── Resume All Units ──

  async resumeAllUnits(): Promise<ResumeAllUnitResult[]> {
    return resumeAllUnits({
      shipManager: this.shipManager,
      processManager: this.processManager,
      flagshipManager: this.flagshipManager,
      dockManager: this.dockManager,
      loadFleets: () => loadFleets(),
    });
  }

  // ── Shutdown ──

  shutdown(): void {
    if (this.questionTimeoutTimer) {
      clearInterval(this.questionTimeoutTimer);
      this.questionTimeoutTimer = null;
    }
    if (this.processLivenessTimer) {
      clearInterval(this.processLivenessTimer);
      this.processLivenessTimer = null;
    }
    this.caffeinateManager.shutdown();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
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
