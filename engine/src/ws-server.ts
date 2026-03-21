import { WebSocketServer, type WebSocket } from "ws";
import { readFile, writeFile, mkdir, stat, readdir, realpath } from "node:fs/promises";
import { join, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { ProcessManager } from "./process-manager.js";
import { ShipManager } from "./ship-manager.js";
import { BridgeManager } from "./bridge.js";
import { StatusManager } from "./status-manager.js";
import { StateSync } from "./state-sync.js";
import { BridgeRequestHandler } from "./bridge-request-handler.js";
import * as github from "./github.js";
import {
  parseStreamMessage,
  extractSessionId,
  extractRequests,
  stripRequestBlocks,
  isBridgeRequest,
  isShipRequest,
} from "./stream-parser.js";
import { ShipRequestHandler } from "./ship-request-handler.js";
import type { StatusTransitionResult } from "./ship-request-handler.js";
import { buildBridgeSystemPrompt } from "./bridge-system-prompt.js";
import { Lookout } from "./lookout.js";
import type { LookoutAlert } from "./lookout.js";
import { initFleetDatabase } from "./db.js";
import type { FleetDatabase } from "./db.js";
import type { Fleet, FleetRepo, FleetSkillSources, FleetGateSettings, ClientMessage, BridgeRequest, StreamMessage, ShipRequest } from "./types.js";

const FLEETS_DIR =
  join(process.env.HOME ?? "~", ".vibe-admiral");
const FLEETS_FILE = join(FLEETS_DIR, "fleets.json");

export class EngineServer {
  private wss: WebSocketServer;
  private processManager: ProcessManager;
  private shipManager: ShipManager;
  private bridgeManager: BridgeManager;
  private statusManager: StatusManager;
  private stateSync: StateSync;
  private requestHandler: BridgeRequestHandler;
  private shipRequestHandler: ShipRequestHandler;
  private lookout: Lookout;
  private clients = new Set<WebSocket>();
  private launchingBridges = new Set<string>();
  private bridgeFirstData = new Set<string>();
  private questionTimeoutTimer: ReturnType<typeof setInterval> | null = null;
  private processLivenessTimer: ReturnType<typeof setInterval> | null = null;
  /** Per-ship mutex to serialize executeShipRequests() calls. */
  private shipRequestLocks = new Map<string, Promise<void>>();
  private fleetDb: FleetDatabase | null = null;

  /** Unanswered Bridge questions auto-answered after this duration (ms). */
  private static readonly QUESTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  constructor(port: number) {
    this.processManager = new ProcessManager();
    this.statusManager = new StatusManager();
    this.shipManager = new ShipManager(
      this.processManager,
      this.statusManager,
    );
    this.bridgeManager = new BridgeManager(this.processManager);
    this.stateSync = new StateSync(this.shipManager, this.statusManager);
    this.requestHandler = new BridgeRequestHandler(this.shipManager, this.stateSync);
    this.shipRequestHandler = new ShipRequestHandler(this.shipManager);
    this.lookout = new Lookout(this.shipManager, this.processManager);

    this.wss = new WebSocketServer({ port });
    this.setupWSS();
    this.setupProcessEvents();
    this.setupShipStatusHandler();
    this.runStartupReconciliation();
    this.startQuestionTimeoutScanner();
    this.setupLookout();
    this.startProcessLivenessCheck();
    // Note: ShipStatusWatcher (file-based IPC) has been replaced by
    // admiral-request protocol for Ship → Engine status transitions.

    console.log(`Engine WebSocket server running on port ${port}`);
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
    });
  }

  private setupProcessEvents(): void {
    this.processManager.on("data", (id: string, msg: Record<string, unknown>) => {
      // Route to bridge or ship
      if (id.startsWith("bridge-")) {
        const fleetId = id.replace("bridge-", "");

        // Extract sessionId from Bridge init messages (before parsing drops them)
        const sessionId = extractSessionId(msg);
        if (sessionId) {
          this.bridgeManager.setSessionId(fleetId, sessionId);
          console.log(
            `[ws-server] Bridge ${id} sessionId captured: ${sessionId.slice(0, 12)}...`,
          );
        }

        // Emit "connected" status on first data from bridge CLI
        if (!this.bridgeFirstData.has(id)) {
          this.bridgeFirstData.add(id);
          const pid = this.processManager.getPid(id);
          const connMsg = {
            type: "system" as const,
            subtype: "bridge-status" as const,
            content: `Bridge CLI connected${pid ? ` (pid: ${pid})` : ""}`,
          };
          this.bridgeManager.addToHistory(fleetId, connMsg);
          this.broadcast({
            type: "bridge:stream",
            data: { fleetId, message: connMsg },
          });
        }

        const parsed = parseStreamMessage(msg);
        if (parsed) {
          // AskUserQuestion tool_use — forward as bridge:question
          if (
            parsed.type === "tool_use" &&
            parsed.tool === "AskUserQuestion"
          ) {
            const toolInput = parsed.toolInput as Record<string, unknown> | undefined;
            const question = toolInput?.question as string | undefined;
            const toolUseId = parsed.toolUseId as string | undefined;
            const questionMessage: StreamMessage = {
              type: "question",
              content: question ?? "Bridge is asking a question",
              ...(toolUseId ? { toolUseId } : {}),
            };
            this.bridgeManager.addToHistory(fleetId, questionMessage);
            // Track pending question for timeout and bridge:send guard
            if (toolUseId) {
              this.bridgeManager.setPendingQuestion(fleetId, toolUseId);
            }
            this.broadcast({
              type: "bridge:question",
              data: { fleetId, message: questionMessage },
            });
          // Check for admiral-request blocks in assistant text
          } else if (parsed.type === "assistant" && parsed.content) {
            const allRequests = extractRequests(parsed.content);
            // Filter to Bridge-only requests (Ship requests from Bridge are ignored)
            const requests = allRequests.filter(isBridgeRequest);
            const cleanContent = stripRequestBlocks(parsed.content);

            // Broadcast clean text (without request blocks) to frontend
            if (cleanContent) {
              const cleanMessage = { ...parsed, content: cleanContent };
              this.bridgeManager.addToHistory(fleetId, cleanMessage);
              this.broadcast({
                type: "bridge:stream",
                data: { fleetId, message: cleanMessage },
              });
            }

            // Execute requests sequentially and batch results
            if (requests.length > 0) {
              const bridgeId = `bridge-${fleetId}`;
              this.executeRequestsSequentially(fleetId, bridgeId, requests);
            }
          } else if (parsed.type !== "result") {
            // Non-assistant or no content — pass through normally
            // Skip "result" messages: they duplicate the preceding "assistant" text
            this.bridgeManager.addToHistory(fleetId, parsed);
            this.broadcast({
              type: "bridge:stream",
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
          // Check for admiral-request blocks in Ship assistant text
          if (parsed.type === "assistant" && parsed.content) {
            const requests = extractRequests(parsed.content);
            const cleanContent = stripRequestBlocks(parsed.content);

            // Broadcast clean text (without request blocks) to frontend
            if (cleanContent) {
              const cleanMessage = { ...parsed, content: cleanContent };
              this.logShipMessage(id, cleanMessage);
              this.broadcast({
                type: "ship:stream",
                data: { id, message: cleanMessage },
              });
            }

            // Detect PR URL BEFORE processing admiral-requests so that
            // ship.prUrl is populated when gate check messages are built.
            // Fixes #293: code-review gate showing "PR: not yet created"
            // when PR URL and status-transition appear in the same message.
            if (cleanContent) {
              const cleanMsg = { ...parsed, content: cleanContent };
              this.detectPRCreation(id, cleanMsg);
            }

            // Execute Ship requests (only status-transition allowed)
            // Serialized per-ship to prevent race conditions with duplicate
            // admiral-request blocks from cumulative stream-json messages.
            const shipRequests = requests.filter(isShipRequest);
            if (shipRequests.length > 0) {
              const prev = this.shipRequestLocks.get(id) ?? Promise.resolve();
              const next = prev.then(() => this.executeShipRequests(id, shipRequests)).catch(console.error);
              this.shipRequestLocks.set(id, next);
            }

            // Reject any Bridge-only requests from Ship
            const bridgeOnly = requests.filter(isBridgeRequest);
            if (bridgeOnly.length > 0) {
              console.warn(
                `[ws-server] Ship ${id} attempted Bridge-only requests: ${bridgeOnly.map((r) => r.request).join(", ")}`,
              );
            }
          } else {
            this.logShipMessage(id, parsed);
            this.broadcast({
              type: "ship:stream",
              data: { id, message: parsed },
            });

            // Detect PR URL in result messages and notify Bridge
            this.detectPRCreation(id, parsed);
          }
        }
      }
    });

    this.processManager.on("exit", (id: string, code: number | null) => {
      if (id.startsWith("bridge-")) {
        this.bridgeFirstData.delete(id);
        const fleetId = id.replace("bridge-", "");
        console.log(`Bridge ${id} exited with code ${code}`);
        this.broadcast({
          type: "bridge:stream",
          data: {
            fleetId,
            message: {
              type: code === 0 ? "system" : "error",
              content:
                code === 0
                  ? "Bridge session ended."
                  : `Bridge process exited with code ${code}.`,
            },
          },
        });
      } else {
        console.log(`Ship ${id} exited with code ${code}`);
        this.shipRequestLocks.delete(id);
        const ship = this.shipManager.getShip(id);
        if (!ship) {
          console.warn(`[ws-server] Ship ${id} exited but is not tracked — skipping cleanup`);
          return;
        }
        // Ship explicitly declares "done" via admiral-request status-transition.
        // If the process exits while in "done" phase, treat as success.
        // If in "merging" phase (squash merge may kill the process), also treat as success.
        const successPhases = new Set(["done", "merging"]);
        if (successPhases.has(ship.phase)) {
          this.stateSync.onProcessExit(id, true).catch(console.error);
        } else {
          // Process exited without declaring done — treat as failure.
          this.stateSync.onProcessExit(id, false).catch(console.error);
        }
      }
    });

    this.processManager.on("rate-limit", (id: string) => {
      if (id.startsWith("bridge-")) {
        console.warn(`[ws-server] Bridge ${id} hit rate limit`);
        return;
      }
      console.warn(
        `[ws-server] Ship ${id.slice(0, 8)}... hit rate limit — will stop and await manual retry`,
      );
    });

    this.processManager.on("error", (id: string, error: Error) => {
      console.error(`Process ${id} error:`, error.message);
      if (id.startsWith("bridge-")) {
        const fleetId = id.replace("bridge-", "");
        const hadData = this.bridgeFirstData.has(id);
        this.bridgeFirstData.delete(id);
        // Only show "Failed to start" if bridge never sent data (spawn failure)
        if (!hadData) {
          const errMsg = {
            type: "system" as const,
            subtype: "bridge-status" as const,
            content: `Failed to start Bridge CLI: ${error.message}`,
          };
          this.bridgeManager.addToHistory(fleetId, errMsg);
          this.broadcast({
            type: "bridge:stream",
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

      this.broadcast({
        type: "ship:status",
        data: {
          id,
          phase: phase,
          detail,
          fleetId: ship?.fleetId,
          repo: ship?.repo,
          issueNumber: ship?.issueNumber,
          issueTitle: ship?.issueTitle,
          ...(ship?.nothingToDo && {
            nothingToDo: true,
            nothingToDoReason: ship.nothingToDoReason,
          }),
        },
      });

      // Also inject into Bridge chat for the ship's fleet
      if (ship) {
        const nothingToDoSuffix = ship.nothingToDo && phase === "done" ? " (nothing to do)" : "";
        const resumeInfo = detail === "Process dead"
          ? `\nShip ID: ${ship.id}\nResumable: ${ship.sessionId ? "yes (session available)" : "no (no session — re-sortie only)"}\nWorktree: ${ship.worktreePath}`
          : "";
        const statusMessage = {
          type: "system" as const,
          subtype: "ship-status" as const,
          content: `Ship #${ship.issueNumber} (${ship.issueTitle}): ${phase}${nothingToDoSuffix}${detail ? ` — ${detail}` : ""}${resumeInfo}`,
          meta: {
            category: "ship-status" as const,
            issueNumber: ship.issueNumber,
            issueTitle: ship.issueTitle,
          },
        };
        this.bridgeManager.addToHistory(ship.fleetId, statusMessage);
        this.broadcast({
          type: "bridge:stream",
          data: { fleetId: ship.fleetId, message: statusMessage },
        });
      }
    });
  }

  private setupLookout(): void {
    this.lookout.setAlertHandler((alert: LookoutAlert) => {
      const ship = this.shipManager.getShip(alert.shipId);
      if (!ship) return;

      const bridgeId = `bridge-${alert.fleetId}`;

      // Build system message for Bridge chat
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
        },
      };

      // Add to Bridge history and broadcast to frontend
      this.bridgeManager.addToHistory(alert.fleetId, alertMessage);
      this.broadcast({
        type: "bridge:stream",
        data: { fleetId: alert.fleetId, message: alertMessage },
      });

      // Send to Bridge stdin if Bridge is running
      if (this.processManager.isRunning(bridgeId)) {
        this.processManager.sendMessage(
          bridgeId,
          `[Lookout Alert] ${alert.message}`,
        );
      }
    });

    this.lookout.start();
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

        // Bridge operations
        case "bridge:send": {
          const fleetId = data.fleetId as string;
          const message = data.message as string;

          // Guard: reject if a question is pending
          const pending = this.bridgeManager.getPendingQuestion(fleetId);
          if (pending) {
            this.sendTo(ws, {
              type: "error",
              data: {
                source: "bridge:send",
                message: "Cannot send a command while a question is pending. Please answer the question first.",
              },
            });
            break;
          }

          const rawImages = data.images as Array<{ base64: string; mediaType: string }> | undefined;
          const ALLOWED_MEDIA = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
          const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5 MB base64 (~3.75 MB raw)
          const MAX_IMAGES = 10;
          const images = rawImages
            ?.filter((img) => ALLOWED_MEDIA.has(img.mediaType) && img.base64.length <= MAX_IMAGE_SIZE)
            .slice(0, MAX_IMAGES);
          if (
            !this.bridgeManager.hasSession(fleetId) &&
            !this.launchingBridges.has(fleetId)
          ) {
            this.launchingBridges.add(fleetId);
            try {
              const fleets = await this.loadFleets();
              const fleet = fleets.find((f) => f.id === fleetId);
              if (!fleet) {
                throw new Error(`Fleet not found: ${fleetId}`);
              }
              const remoteNames = fleet.repos
                .map((r) => r.remote)
                .filter((r): r is string => r !== undefined);
              let prompt = buildBridgeSystemPrompt(
                fleet.name,
                remoteNames,
                fleet.maxConcurrentSorties ?? 6,
              );

              // Load and append shared + bridge rules
              const sharedRules = await this.loadRules(fleet.sharedRulePaths ?? []);
              const bridgeRules = await this.loadRules(fleet.bridgeRulePaths ?? []);
              const rulesSuffix = [sharedRules, bridgeRules].filter(Boolean).join("\n\n");
              if (rulesSuffix) {
                prompt = `${prompt}\n\n## Additional Rules\n\n${rulesSuffix}`;
              }

              await this.bridgeManager.launch(
                fleetId,
                process.cwd(),
                [],
                prompt,
              );

              // Notify frontend that bridge is starting (after successful launch)
              const startMsg = {
                type: "system" as const,
                subtype: "bridge-status" as const,
                content: "Starting Bridge session...",
              };
              this.bridgeManager.addToHistory(fleetId, startMsg);
              this.broadcast({
                type: "bridge:stream",
                data: { fleetId, message: startMsg },
              });
            } finally {
              this.launchingBridges.delete(fleetId);
            }
          }
          this.bridgeManager.send(fleetId, message, images);
          break;
        }
        case "bridge:answer": {
          const ansFleetId = data.fleetId as string;
          const answer = data.answer as string;
          const toolUseId = data.toolUseId as string | undefined;
          const bridgeId = `bridge-${ansFleetId}`;

          // Clear pending question state
          this.bridgeManager.clearPendingQuestion(ansFleetId);

          // Record answer in history (no broadcast — frontend uses optimistic update)
          const answerMessage: StreamMessage = {
            type: "user",
            content: answer,
          };
          this.bridgeManager.addToHistory(ansFleetId, answerMessage);

          // Send answer to Bridge stdin as tool_result if toolUseId is available
          if (toolUseId) {
            this.processManager.sendToolResult(bridgeId, toolUseId, answer);
          } else {
            this.processManager.sendMessage(bridgeId, answer);
          }
          break;
        }
        case "bridge:history": {
          const history = this.bridgeManager.getHistory(
            data.fleetId as string,
          );
          this.sendTo(ws, {
            type: "bridge:stream",
            data: {
              fleetId: data.fleetId as string,
              message: { type: "history", content: JSON.stringify(history) },
            },
          });
          break;
        }

        // Ship operations
        case "ship:sortie": {
          const fleets = await this.loadFleets();
          const fleet = fleets.find((f) => f.id === (data.fleetId as string));
          const repoStr = data.repo as string;
          const repoEntry = fleet?.repos.find(
            (r) => r.remote === repoStr || r.localPath === repoStr,
          );
          if (!repoEntry) {
            throw new Error(
              `Repo "${data.repo}" not found in fleet. Register the local path first.`,
            );
          }

          // Sortie guard check
          const remoteId = repoEntry.remote ?? repoStr;
          const guard = await this.stateSync.sortieGuard(remoteId, data.issueNumber as number);
          if (!guard.ok) {
            throw new Error(guard.reason ?? "Sortie guard check failed");
          }

          // Load shared + ship rules for extraPrompt
          const sharedRulesForShip = await this.loadRules(fleet?.sharedRulePaths ?? []);
          const shipRules = await this.loadRules(fleet?.shipRulePaths ?? []);
          const shipExtraPrompt = [sharedRulesForShip, shipRules].filter(Boolean).join("\n\n") || undefined;

          const ship = await this.shipManager.sortie(
            data.fleetId as string,
            data.repo as string,
            data.issueNumber as number,
            repoEntry.localPath,
            fleet?.skillSources,
            shipExtraPrompt,
          );
          this.broadcast({
            type: "ship:created",
            data: {
              id: ship.id,
              fleetId: ship.fleetId,
              repo: ship.repo,
              issueNumber: ship.issueNumber,
              issueTitle: ship.issueTitle,
              phase: ship.phase,
              branchName: ship.branchName,
            },
          });
          break;
        }
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
        case "ship:retry": {
          const retryId = data.id as string;
          const retryShip = this.shipManager.getShip(retryId);
          if (!retryShip || retryShip.phase === "done" || this.processManager.isRunning(retryId)) {
            throw new Error(`Ship "${retryId}" is not eligible for retry`);
          }

          // Load ship rules for re-sortie fallback
          const retriedFleets = await this.loadFleets();
          const retryFleet = retriedFleets.find((f) => f.id === retryShip.fleetId);
          const retrySharedRules = await this.loadRules(retryFleet?.sharedRulePaths ?? []);
          const retryShipRules = await this.loadRules(retryFleet?.shipRulePaths ?? []);
          const retryExtraPrompt = [retrySharedRules, retryShipRules].filter(Boolean).join("\n\n") || undefined;

          const result = this.shipManager.retryShip(retryId, retryExtraPrompt);
          if (!result) {
            throw new Error(`Failed to retry Ship "${retryId}"`);
          }
          break;
        }
        case "ship:stop": {
          const stopId = data.id as string;
          const stopShip = this.shipManager.getShip(stopId);
          this.shipManager.stopShip(stopId);
          // Explicitly rollback label — don't rely solely on process exit handler
          if (stopShip) {
            this.stateSync.rollbackLabel(stopShip.repo, stopShip.issueNumber).catch((err) => {
              console.warn(`[ws-server] Failed to rollback label on ship:stop for #${stopShip.issueNumber}:`, err);
            });
          }
          break;
        }
        case "ship:logs": {
          // Ship logs are streamed in real-time, no separate endpoint needed
          break;
        }
        case "ship:list": {
          const ships = this.shipManager.getAllShips();
          this.sendTo(ws, { type: "ship:data", data: ships });
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
    if (updates.bridgeRulePaths !== undefined) fleet.bridgeRulePaths = updates.bridgeRulePaths as string[];
    if (updates.shipRulePaths !== undefined) fleet.shipRulePaths = updates.shipRulePaths as string[];
    if (updates.gates !== undefined) fleet.gates = updates.gates as FleetGateSettings;
    if (updates.maxConcurrentSorties !== undefined) fleet.maxConcurrentSorties = updates.maxConcurrentSorties as number;
    await this.saveFleets(fleets);
  }

  private async deleteFleet(id: string): Promise<void> {
    let fleets = await this.loadFleets();
    fleets = fleets.filter((f) => f.id !== id);
    await this.saveFleets(fleets);
    this.bridgeManager.stop(id);
  }

  // Messaging helpers
  private sendTo(ws: WebSocket, msg: Record<string, unknown>): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private broadcast(msg: Record<string, unknown>): void {
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) {
        client.send(data);
      }
    }
  }

  private async executeRequestsSequentially(
    fleetId: string,
    bridgeId: string,
    requests: BridgeRequest[],
  ): Promise<void> {
    const fleets = await this.loadFleets();
    const fleet = fleets.find((f) => f.id === fleetId);
    const fleetRepos = fleet?.repos ?? [];
    const repoRemotes = fleetRepos
      .map((r) => r.remote)
      .filter((r): r is string => r !== undefined);

    // Pre-load ship rules for sortie requests
    const sharedRules = await this.loadRules(fleet?.sharedRulePaths ?? []);
    const shipRules = await this.loadRules(fleet?.shipRulePaths ?? []);
    const shipExtraPrompt = [sharedRules, shipRules].filter(Boolean).join("\n\n") || undefined;

    const results: string[] = [];

    for (const request of requests) {
      try {
        const result = await this.requestHandler.handle(
          fleetId,
          request,
          fleetRepos,
          repoRemotes,
          fleet?.skillSources,
          shipExtraPrompt,
          fleet?.maxConcurrentSorties,
        );
        results.push(result);

        const resultMessage = {
          type: "system" as const,
          subtype: "request-result" as const,
          content: result,
        };
        this.bridgeManager.addToHistory(fleetId, resultMessage);
        this.broadcast({
          type: "bridge:stream",
          data: { fleetId, message: resultMessage },
        });
      } catch (err) {
        const errorResult = `[Request Error] ${err instanceof Error ? err.message : String(err)}`;
        results.push(errorResult);

        const errorMessage = {
          type: "system" as const,
          subtype: "request-result" as const,
          content: errorResult,
        };
        this.bridgeManager.addToHistory(fleetId, errorMessage);
        this.broadcast({
          type: "bridge:stream",
          data: { fleetId, message: errorMessage },
        });
      }
    }

    // Send batched results to Bridge stdin
    this.processManager.sendMessage(bridgeId, results.join("\n\n"));
  }

  private async executeShipRequests(
    shipId: string,
    requests: ShipRequest[],
  ): Promise<void> {
    const ship = this.shipManager.getShip(shipId);
    if (!ship) return;

    // Load fleet gate settings for this ship
    const fleets = await this.loadFleets();
    const fleet = fleets.find((f) => f.id === ship.fleetId);

    for (const request of requests) {
      // Capture pre-request gate state to detect gate resolution
      const preGateCheck = ship.gateCheck;

      const response: StatusTransitionResult = await this.shipRequestHandler.handle(shipId, request, fleet?.gates);

      if (response.gate) {
        // Gate check required — set gate state and tell Ship to handle it
        this.shipManager.setGateCheck(shipId, response.gate.gatePhase, response.gate.type);

        // Notify frontend of pending gate
        this.broadcast({
          type: "ship:gate-pending",
          data: {
            id: shipId,
            gatePhase: response.gate.gatePhase,
            gateType: response.gate.type,
            fleetId: ship.fleetId,
            issueNumber: ship.issueNumber,
            issueTitle: ship.issueTitle,
          },
        });

        // Inject gate notification into Bridge chat (informational only)
        const bridgeMsg = {
          type: "system" as const,
          subtype: "gate-check-request" as const,
          content: `Ship #${ship.issueNumber} (${ship.issueTitle}): ${response.gate.gatePhase} gate pending — Ship will handle review autonomously`,
          meta: {
            category: "gate-check-request" as const,
            issueNumber: ship.issueNumber,
            issueTitle: ship.issueTitle,
            gatePhase: response.gate.gatePhase,
            gateType: response.gate.type,
          },
        };
        this.bridgeManager.addToHistory(ship.fleetId, bridgeMsg);
        this.broadcast({
          type: "bridge:stream",
          data: { fleetId: ship.fleetId, message: bridgeMsg },
        });

        // Write response to DB so Ship knows to launch its own Escort
        this.shipManager.writeDbMessage(shipId, "admiral-request-response", "engine", {
          ok: false,
          gate: {
            type: response.gate.type,
            gatePhase: response.gate.gatePhase,
            previousFeedback: response.gate.previousFeedback,
          },
          error: `Gate check required for ${response.gate.gatePhase}. Launch Escort sub-agent.`,
        });
        console.log(
          `[ws-server] Ship ${shipId.slice(0, 8)}... gate check required: ${response.gate.gatePhase} (${response.gate.type}) — Ship will handle`,
        );
      } else {
        // Write response to DB so Ship CLI can poll for the result
        this.shipManager.writeDbMessage(shipId, "admiral-request-response", "engine", response as unknown as Record<string, unknown>);

        if (response.ok) {
          // If a gate was previously pending and now resolved, broadcast gate-resolved
          if (preGateCheck && preGateCheck.status === "pending" && !ship.gateCheck) {
            this.broadcast({
              type: "ship:gate-resolved",
              data: {
                id: shipId,
                gatePhase: preGateCheck.gatePhase,
                gateType: preGateCheck.gateType,
                approved: true,
              },
            });
          }
          console.log(
            `[ws-server] Ship ${shipId.slice(0, 8)}... request ${request.request} succeeded`,
          );
        } else {
          console.warn(
            `[ws-server] Ship ${shipId.slice(0, 8)}... request ${request.request} failed: ${response.error}`,
          );
        }
      }
    }
  }

  private runStartupReconciliation(): void {
    this.initDatabase()
      .then(() => this.loadFleets())
      .then((fleets) => {
        const allRepos = fleets.flatMap((f) => f.repos);
        return this.stateSync.reconcileOnStartup(allRepos);
      })
      .catch((err) => {
        console.warn("[engine] Startup reconciliation failed:", err);
      });
  }

  private async initDatabase(): Promise<void> {
    try {
      const dbDir = join(process.env.HOME ?? homedir(), ".vibe-admiral");
      this.fleetDb = await initFleetDatabase(dbDir);
      this.shipManager.setDatabase(this.fleetDb);
      this.shipRequestHandler.setDatabase(this.fleetDb);
      console.log("[engine] Fleet database initialized");
    } catch (err) {
      console.warn("[engine] Failed to initialize fleet database:", err);
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

    // Broadcast PR creation to frontend
    this.broadcast({
      type: "ship:status",
      data: {
        id,
        phase: ship.phase,
        detail: `PR created: ${prUrl}`,
        fleetId: ship.fleetId,
        repo: ship.repo,
        issueNumber: ship.issueNumber,
        issueTitle: ship.issueTitle,
      },
    });
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

    // Also inject into Bridge chat
    if (isCompacting) {
      const compactMsg = {
        type: "system" as const,
        subtype: "ship-status" as const,
        content: `Ship #${ship.issueNumber} (${ship.issueTitle}): compacting context...`,
      };
      this.bridgeManager.addToHistory(ship.fleetId, compactMsg);
      this.broadcast({
        type: "bridge:stream",
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
    const pending = this.bridgeManager.getSessionsWithPendingQuestion();

    for (const { fleetId, toolUseId, askedAt } of pending) {
      if (now - askedAt <= EngineServer.QUESTION_TIMEOUT_MS) continue;

      console.warn(
        `[ws-server] Bridge question for fleet ${fleetId} timed out after ${EngineServer.QUESTION_TIMEOUT_MS / 1000}s. Auto-answering.`,
      );

      // Clear pending state
      this.bridgeManager.clearPendingQuestion(fleetId);

      // Auto-answer with default message
      const autoAnswer = "No response from user (timed out)";
      const bridgeId = `bridge-${fleetId}`;

      // Record in history
      const answerMsg: StreamMessage = {
        type: "user",
        content: autoAnswer,
      };
      this.bridgeManager.addToHistory(fleetId, answerMsg);

      // Notify frontend
      const timeoutMsg: StreamMessage = {
        type: "system",
        subtype: "bridge-status",
        content: "Question timed out — auto-answered with default response.",
      };
      this.bridgeManager.addToHistory(fleetId, timeoutMsg);
      this.broadcast({
        type: "bridge:stream",
        data: { fleetId, message: answerMsg },
      });
      this.broadcast({
        type: "bridge:stream",
        data: { fleetId, message: timeoutMsg },
      });

      // Clear pendingQuestion on frontend
      this.broadcast({
        type: "bridge:question-timeout",
        data: { fleetId },
      });

      // Send tool_result to Bridge stdin
      this.processManager.sendToolResult(bridgeId, toolUseId, autoAnswer);
    }
  }

  private startProcessLivenessCheck(): void {
    this.processLivenessTimer = setInterval(() => {
      for (const ship of this.shipManager.getAllShips()) {
        if (ship.phase !== "done" && !this.processManager.isRunning(ship.id)) {
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
    this.shipManager.stopAll();
    this.bridgeManager.stopAll();
    this.processManager.killAll();
    this.fleetDb?.close();
    this.wss.close();
  }
}
