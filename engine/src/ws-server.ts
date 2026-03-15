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
import { AcceptanceWatcher } from "./acceptance-watcher.js";
import { ActionExecutor } from "./action-executor.js";
import * as github from "./github.js";
import {
  parseStreamMessage,
  extractActions,
  stripActionBlocks,
} from "./stream-parser.js";
import { buildBridgeSystemPrompt } from "./bridge-system-prompt.js";
import type { Fleet, FleetRepo, ClientMessage, BridgeAction, StreamMessage } from "./types.js";

const FLEETS_DIR =
  join(process.env.HOME ?? "~", ".vibe-admiral");
const FLEETS_FILE = join(FLEETS_DIR, "fleets.json");

export class EngineServer {
  private wss: WebSocketServer;
  private processManager: ProcessManager;
  private shipManager: ShipManager;
  private bridgeManager: BridgeManager;
  private acceptanceWatcher: AcceptanceWatcher;
  private actionExecutor: ActionExecutor;
  private clients = new Set<WebSocket>();
  private launchingBridges = new Set<string>();
  private bridgeFirstData = new Set<string>();

  constructor(port: number) {
    this.processManager = new ProcessManager();
    this.acceptanceWatcher = new AcceptanceWatcher();
    this.shipManager = new ShipManager(
      this.processManager,
      this.acceptanceWatcher,
    );
    this.bridgeManager = new BridgeManager(this.processManager);
    this.actionExecutor = new ActionExecutor(this.shipManager);

    this.wss = new WebSocketServer({ port });
    this.setupWSS();
    this.setupProcessEvents();
    this.setupAcceptanceEvents();
    this.setupShipStatusHandler();

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

        // Emit "connected" status on first data from bridge CLI
        if (!this.bridgeFirstData.has(id)) {
          this.bridgeFirstData.add(id);
          const pid = this.processManager.getPid(id);
          const connMsg = {
            type: "system" as const,
            subtype: "bridge-status",
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
          // Check for admiral-action blocks in assistant text
          if (parsed.type === "assistant" && parsed.content) {
            const actions = extractActions(parsed.content);
            const cleanContent = stripActionBlocks(parsed.content);

            // Broadcast clean text (without action blocks) to frontend
            if (cleanContent) {
              const cleanMessage = { ...parsed, content: cleanContent };
              this.bridgeManager.addToHistory(fleetId, cleanMessage);
              this.broadcast({
                type: "bridge:stream",
                data: { fleetId, message: cleanMessage },
              });
            }

            // Execute actions sequentially and batch results
            if (actions.length > 0) {
              const bridgeId = `bridge-${fleetId}`;
              this.executeActionsSequentially(fleetId, bridgeId, actions);
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
        // Ship stream — parse raw CLI JSON before broadcast
        const parsed = parseStreamMessage(msg);
        if (parsed) {
          this.shipManager.updatePhaseFromStream(id, parsed);
          this.logShipMessage(id, parsed);
          this.broadcast({
            type: "ship:stream",
            data: { id, message: parsed },
          });
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
        const ship = this.shipManager.getShip(id);
        const completedPhases = new Set([
          "merging", "reviewing", "acceptance-test", "testing",
        ]);
        if (code === 0 && ship && completedPhases.has(ship.status)) {
          // Ship reached a late phase — treat as successful completion
          this.shipManager.onShipComplete(id).catch(console.error);
        } else if (code === 0) {
          // Ship exited code 0 but never got past early phases — likely a
          // startup error (e.g. unknown skill). Don't close the issue.
          this.shipManager.updateStatus(
            id,
            "error",
            "Process exited before completing implementation",
          );
        } else {
          this.shipManager.updateStatus(
            id,
            "error",
            `Process exited with code ${code}`,
          );
        }
      }
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
            subtype: "bridge-status",
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

  private setupAcceptanceEvents(): void {
    this.acceptanceWatcher.on(
      "request",
      (shipId: string, request: { url: string; checks: string[] }) => {
        const ship = this.shipManager.getShip(shipId);
        if (ship) {
          ship.acceptanceTest = request;
          this.shipManager.updateStatus(shipId, "acceptance-test");
          this.broadcast({
            type: "ship:acceptance-test",
            data: { id: shipId, url: request.url, checks: request.checks },
          });

          // Also inject into Bridge chat
          const acceptanceMessage = {
            type: "system" as const,
            subtype: "acceptance-test",
            content: `Ship #${ship.issueNumber} (${ship.issueTitle}) requests acceptance test\nURL: ${request.url}\nChecks: ${request.checks.join(", ")}`,
          };
          this.bridgeManager.addToHistory(ship.fleetId, acceptanceMessage);
          this.broadcast({
            type: "bridge:stream",
            data: { fleetId: ship.fleetId, message: acceptanceMessage },
          });
        }
      },
    );
  }

  private setupShipStatusHandler(): void {
    this.shipManager.setStatusChangeHandler((id, status, detail) => {
      const ship = this.shipManager.getShip(id);
      this.broadcast({
        type: "ship:status",
        data: {
          id,
          status,
          detail,
          fleetId: ship?.fleetId,
          repo: ship?.repo,
          issueNumber: ship?.issueNumber,
          issueTitle: ship?.issueTitle,
        },
      });

      // Also inject into Bridge chat for the ship's fleet
      if (ship) {
        const statusMessage = {
          type: "system" as const,
          subtype: "ship-status",
          content: `Ship #${ship.issueNumber} (${ship.issueTitle}): ${status}${detail ? ` — ${detail}` : ""}`,
        };
        this.bridgeManager.addToHistory(ship.fleetId, statusMessage);
        this.broadcast({
          type: "bridge:stream",
          data: { fleetId: ship.fleetId, message: statusMessage },
        });
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
          await this.updateFleet(
            data.id as string,
            data.name as string | undefined,
            data.repos as FleetRepo[] | undefined,
          );
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
              const prompt = buildBridgeSystemPrompt(
                fleet.name,
                remoteNames,
              );
              this.bridgeManager.launch(
                fleetId,
                process.cwd(),
                [],
                prompt,
              );

              // Notify frontend that bridge is starting (after successful launch)
              const startMsg = {
                type: "system" as const,
                subtype: "bridge-status",
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
          this.bridgeManager.send(fleetId, message);
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
          const ship = await this.shipManager.sortie(
            data.fleetId as string,
            data.repo as string,
            data.issueNumber as number,
            repoEntry.localPath,
          );
          this.broadcast({
            type: "ship:created",
            data: {
              id: ship.id,
              fleetId: ship.fleetId,
              repo: ship.repo,
              issueNumber: ship.issueNumber,
              issueTitle: ship.issueTitle,
              status: ship.status,
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
        case "ship:accept": {
          this.shipManager.respondToAcceptanceTest(
            data.id as string,
            true,
          );
          break;
        }
        case "ship:reject": {
          this.shipManager.respondToAcceptanceTest(
            data.id as string,
            false,
            data.feedback as string,
          );
          break;
        }
        case "ship:stop": {
          this.shipManager.stopShip(data.id as string);
          break;
        }
        case "ship:logs": {
          // Ship logs are streamed in real-time, no separate endpoint needed
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
    name?: string,
    repos?: FleetRepo[],
  ): Promise<void> {
    const fleets = await this.loadFleets();
    const fleet = fleets.find((f) => f.id === id);
    if (!fleet) throw new Error(`Fleet not found: ${id}`);
    if (name !== undefined) fleet.name = name;
    if (repos !== undefined) fleet.repos = await this.enrichRepos(repos);
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

  private async executeActionsSequentially(
    fleetId: string,
    bridgeId: string,
    actions: BridgeAction[],
  ): Promise<void> {
    // Load fleet repos for whitelist validation (use remote identifiers)
    const fleets = await this.loadFleets();
    const fleet = fleets.find((f) => f.id === fleetId);
    const fleetRepos = fleet?.repos ?? [];
    const repoRemotes = fleetRepos
      .map((r) => r.remote)
      .filter((r): r is string => r !== undefined);

    const results: string[] = [];

    for (const action of actions) {
      try {
        const result = await this.actionExecutor.execute(
          fleetId,
          action,
          repoRemotes,
          fleetRepos,
        );
        results.push(result);

        // Broadcast each result to frontend as it completes
        const resultMessage = {
          type: "system" as const,
          subtype: "action-result",
          content: result,
        };
        this.bridgeManager.addToHistory(fleetId, resultMessage);
        this.broadcast({
          type: "bridge:stream",
          data: { fleetId, message: resultMessage },
        });
      } catch (err) {
        const errorResult = `[Action Error] ${err instanceof Error ? err.message : String(err)}`;
        results.push(errorResult);

        const errorMessage = {
          type: "system" as const,
          subtype: "action-result",
          content: errorResult,
        };
        this.bridgeManager.addToHistory(fleetId, errorMessage);
        this.broadcast({
          type: "bridge:stream",
          data: { fleetId, message: errorMessage },
        });
      }
    }

    // Send batched results to Bridge stdin as a single message
    this.processManager.sendMessage(bridgeId, results.join("\n\n"));
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

  shutdown(): void {
    this.shipManager.stopAll();
    this.bridgeManager.stopAll();
    this.processManager.killAll();
    this.acceptanceWatcher.unwatchAll();
    this.wss.close();
  }
}
