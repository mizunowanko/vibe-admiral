/**
 * WebSocket message handlers, fleet CRUD, admiral settings, and commander operations.
 * Extracted from ws-server.ts (ADR-0016 Phase 1).
 */
import type { WebSocket } from "ws";
import { readFile, writeFile, mkdir, stat, readdir, realpath } from "node:fs/promises";
import { join, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import type { ProcessManagerLike } from "./process-manager.js";
import type { ShipManager } from "./ship-manager.js";
import type { FlagshipManager } from "./flagship.js";
import type { DockManager } from "./dock.js";
import type { CaffeinateManager } from "./caffeinate-manager.js";
import * as github from "./github.js";
import { buildFlagshipSystemPrompt } from "./flagship-system-prompt.js";
import { buildDockSystemPrompt } from "./dock-system-prompt.js";
import { getAdmiralHome } from "./admiral-home.js";
import { applyTemplate, mergeSettings } from "./deep-merge.js";
import type { FleetDatabase } from "./db.js";
import type {
  Fleet, FleetRepo, FleetSkillSources, FleetGateSettings, GateType,
  CustomInstructions, ClientMessage, StreamMessage, CommanderRole,
  AdmiralSettings, SettingsLayer, ServerMessage,
} from "./types.js";

// ── Fleet/Settings Persistence Constants ──

/** Admiral repo's units/ directory, resolved from Engine's own source location. */
const ADMIRAL_UNITS_DIR = join(import.meta.dirname, "..", "..", "units");

const FLEETS_DIR = getAdmiralHome();
const FLEETS_FILE = join(FLEETS_DIR, "fleets.json");
const ADMIRAL_SETTINGS_FILE = join(FLEETS_DIR, "admiral-settings.json");

// ── Fleet Persistence ──

export async function loadFleets(): Promise<Fleet[]> {
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
      await saveFleets(parsed);
    }
    return parsed;
  } catch {
    return [];
  }
}

export async function saveFleets(fleets: Fleet[]): Promise<void> {
  await mkdir(FLEETS_DIR, { recursive: true });
  await writeFile(FLEETS_FILE, JSON.stringify(fleets, null, 2));
}

// ── Admiral Settings Persistence ──

export async function loadAdmiralSettings(): Promise<AdmiralSettings> {
  try {
    const content = await readFile(ADMIRAL_SETTINGS_FILE, "utf-8");
    return JSON.parse(content) as AdmiralSettings;
  } catch {
    return { global: {}, template: {} };
  }
}

export async function saveAdmiralSettings(settings: AdmiralSettings): Promise<void> {
  await mkdir(FLEETS_DIR, { recursive: true });
  await writeFile(ADMIRAL_SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// ── Rule Loading ──

export async function loadRules(paths: string[]): Promise<string> {
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

// ── Fleet Utilities ──

async function resolveRemote(localPath: string): Promise<string | undefined> {
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

async function validateLocalPath(localPath: string): Promise<void> {
  if (!isAbsolute(localPath)) {
    throw new Error(`localPath must be absolute: "${localPath}"`);
  }
  const s = await stat(localPath).catch(() => null);
  if (!s?.isDirectory()) {
    throw new Error(`localPath is not a directory: "${localPath}"`);
  }
}

async function enrichRepos(repos: FleetRepo[]): Promise<FleetRepo[]> {
  return Promise.all(
    repos.map(async (repo) => {
      await validateLocalPath(repo.localPath);
      if (repo.remote) return repo;
      const remote = await resolveRemote(repo.localPath);
      return remote ? { ...repo, remote } : repo;
    }),
  );
}

async function createFleet(
  name: string,
  repos: FleetRepo[],
): Promise<Fleet> {
  const enriched = await enrichRepos(repos);
  const fleets = await loadFleets();
  // Apply template settings from Admiral settings (snapshot at creation time)
  const admiralSettings = await loadAdmiralSettings();
  const templateDefaults = applyTemplate(admiralSettings.template);
  const fleet: Fleet = {
    id: randomUUID(),
    name,
    repos: enriched,
    ...templateDefaults,
    createdAt: new Date().toISOString(),
  };
  fleets.push(fleet);
  await saveFleets(fleets);
  return fleet;
}

async function updateFleet(
  id: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const fleets = await loadFleets();
  const fleet = fleets.find((f) => f.id === id);
  if (!fleet) throw new Error(`Fleet not found: ${id}`);
  if (updates.name !== undefined) fleet.name = updates.name as string;
  if (updates.repos !== undefined) fleet.repos = await enrichRepos(updates.repos as FleetRepo[]);
  if (updates.skillSources !== undefined) fleet.skillSources = updates.skillSources as FleetSkillSources;
  if (updates.sharedRulePaths !== undefined) fleet.sharedRulePaths = updates.sharedRulePaths as string[];
  if (updates.flagshipRulePaths !== undefined) fleet.flagshipRulePaths = updates.flagshipRulePaths as string[];
  if (updates.dockRulePaths !== undefined) fleet.dockRulePaths = updates.dockRulePaths as string[];
  if (updates.shipRulePaths !== undefined) fleet.shipRulePaths = updates.shipRulePaths as string[];
  if (updates.customInstructions !== undefined) fleet.customInstructions = updates.customInstructions as CustomInstructions;
  if (updates.gates !== undefined) fleet.gates = updates.gates as FleetGateSettings;
  if (updates.gatePrompts !== undefined) fleet.gatePrompts = updates.gatePrompts as Partial<Record<GateType, string>>;
  if (updates.maxConcurrentSorties !== undefined) fleet.maxConcurrentSorties = updates.maxConcurrentSorties as number;
  await saveFleets(fleets);
}

async function deleteFleet(
  id: string,
  flagshipManager: FlagshipManager,
  dockManager: DockManager,
): Promise<void> {
  let fleets = await loadFleets();
  fleets = fleets.filter((f) => f.id !== id);
  await saveFleets(fleets);
  await flagshipManager.stop(id);
  await dockManager.stop(id);
}

// ── Message Handler Deps ──

export interface MessageHandlerDeps {
  shipManager: ShipManager;
  processManager: ProcessManagerLike;
  flagshipManager: FlagshipManager;
  dockManager: DockManager;
  caffeinateManager: CaffeinateManager;
  launchingCommanders: Set<string>;
  getFleetDb: () => FleetDatabase | null;
  broadcast: (msg: ServerMessage) => void;
  sendTo: (ws: WebSocket, msg: ServerMessage) => void;
}

// ── Main Message Handler ──

export async function handleMessage(
  deps: MessageHandlerDeps,
  ws: WebSocket,
  msg: ClientMessage,
): Promise<void> {
  const {
    shipManager, processManager, flagshipManager, dockManager,
    caffeinateManager, broadcast, sendTo,
  } = deps;
  const data = msg.data ?? {};

  try {
    switch (msg.type) {
      // Fleet operations
      case "fleet:create": {
        const newFleet = await createFleet(
          data.name as string,
          data.repos as FleetRepo[],
        );
        // Register repos in DB with fleet_id so Commander can use them immediately
        const db = deps.getFleetDb();
        if (db) {
          for (const repo of newFleet.repos) {
            if (!repo.remote) continue;
            const [owner, name] = repo.remote.split("/");
            if (owner && name) {
              db.ensureRepo(owner, name, newFleet.id);
            }
          }
        }
        const fleets = await loadFleets();
        sendTo(ws, {
          type: "fleet:created",
          data: { id: newFleet.id, fleets },
        });
        break;
      }
      case "fleet:list": {
        const fleets = await loadFleets();
        sendTo(ws, { type: "fleet:data", data: fleets });
        break;
      }
      case "fleet:select": {
        const fleets = await loadFleets();
        sendTo(ws, { type: "fleet:data", data: fleets });
        break;
      }
      case "fleet:update": {
        await updateFleet(data.id as string, data);
        const fleets = await loadFleets();
        sendTo(ws, { type: "fleet:data", data: fleets });
        break;
      }
      case "fleet:delete": {
        await deleteFleet(data.id as string, flagshipManager, dockManager);
        const fleets = await loadFleets();
        sendTo(ws, { type: "fleet:data", data: fleets });
        break;
      }

      // Admiral settings operations
      case "admiral-settings:get": {
        const admiralSettings = await loadAdmiralSettings();
        sendTo(ws, { type: "admiral-settings:data", data: admiralSettings });
        break;
      }
      case "admiral-settings:update": {
        const current = await loadAdmiralSettings();
        if (data.global !== undefined) current.global = data.global as SettingsLayer;
        if (data.template !== undefined) current.template = data.template as SettingsLayer;
        if (data.caffeinateEnabled !== undefined) current.caffeinateEnabled = data.caffeinateEnabled as boolean;
        await saveAdmiralSettings(current);
        caffeinateManager.setEnabled(current.caffeinateEnabled !== false);
        broadcast({ type: "admiral-settings:data", data: current });
        break;
      }

      case "caffeinate:get": {
        sendTo(ws, { type: "caffeinate:status", data: caffeinateManager.getStatus() });
        break;
      }

      // Flagship operations
      case "flagship:send": {
        await handleCommanderSend(deps, ws, data, "flagship");
        break;
      }
      case "flagship:answer": {
        handleCommanderAnswer(deps, data, "flagship");
        break;
      }
      case "flagship:history": {
        await handleCommanderHistory(deps, ws, data, "flagship");
        break;
      }

      // Dock operations
      case "dock:send": {
        await handleCommanderSend(deps, ws, data, "dock");
        break;
      }
      case "dock:answer": {
        handleCommanderAnswer(deps, data, "dock");
        break;
      }
      case "dock:history": {
        await handleCommanderHistory(deps, ws, data, "dock");
        break;
      }

      // Ship operations (sortie/stop/retry/list moved to REST API — see api-server.ts)
      case "ship:chat": {
        const ship = shipManager.getShip(data.id as string);
        if (ship?.sessionId) {
          processManager.resumeSession(
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
        const logs = await shipManager.loadShipLogs(shipId, limit);
        sendTo(ws, {
          type: "ship:history",
          data: { id: shipId, messages: logs },
        });
        break;
      }

      // Issue operations (deterministic - no LLM)
      case "issue:list": {
        const issues = await github.listIssues(data.repo as string);
        sendTo(ws, {
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
        sendTo(ws, {
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
        sendTo(ws, {
          type: "fs:dir-listing",
          data: { path: resolved, entries },
        });
        break;
      }

      default:
        sendTo(ws, {
          type: "error",
          data: { source: "ws", message: `Unknown message type: ${msg.type}` },
        });
    }
  } catch (err) {
    sendTo(ws, {
      type: "error",
      data: {
        source: msg.type,
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

// ── Commander Operations ──

async function handleCommanderSend(
  deps: MessageHandlerDeps,
  ws: WebSocket,
  data: Record<string, unknown>,
  role: CommanderRole,
): Promise<void> {
  const { flagshipManager, dockManager, launchingCommanders, broadcast } = deps;
  const manager = role === "flagship" ? flagshipManager : dockManager;
  const fleetId = data.fleetId as string;
  const message = data.message as string;

  // Guard: reject if a question is pending
  const pending = manager.getPendingQuestion(fleetId);
  if (pending) {
    deps.sendTo(ws, {
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
    !launchingCommanders.has(launchKey)
  ) {
    launchingCommanders.add(launchKey);
    try {
      const fleets = await loadFleets();
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
        roleRules = await loadRules(fleet.flagshipRulePaths ?? fleet.bridgeRulePaths ?? []);
      } else {
        prompt = buildDockSystemPrompt(fleet.name, remoteNames);
        roleRules = await loadRules(fleet.dockRulePaths ?? []);
      }

      const sharedRules = await loadRules(fleet.sharedRulePaths ?? []);
      const rulesSuffix = [sharedRules, roleRules].filter(Boolean).join("\n\n");
      if (rulesSuffix) {
        prompt = `${prompt}\n\n## Additional Rules\n\n${rulesSuffix}`;
      }

      // Merge Admiral Global settings with per-Fleet settings (#881)
      const admiralSettings = await loadAdmiralSettings();
      const mergedCommanderSettings = mergeSettings(admiralSettings.global, {
        customInstructions: fleet.customInstructions,
      });
      const ci = mergedCommanderSettings.customInstructions;
      const ciParts = [ci?.shared, role === "flagship" ? ci?.flagship : ci?.dock].filter(Boolean);
      const customInstructionsText = ciParts.length > 0 ? ciParts.join("\n\n") : undefined;
      if (customInstructionsText) {
        prompt = `${prompt}\n\n## Custom Instructions\n\n${customInstructionsText}`;
      }

      // Use Fleet repo as Commander's cwd instead of vibe-admiral repo.
      // This prevents vibe-admiral's .claude/rules/ (e.g. ヤンキー口調) from
      // being auto-injected into Commander sessions (#859, #736, #678, #649).
      const fleetPath = fleet.repos[0]?.localPath || process.cwd();

      await manager.launch(
        fleetId,
        fleetPath,
        [],
        prompt,
        ADMIRAL_UNITS_DIR,
        customInstructionsText,
      );

      const roleLabel = role === "flagship" ? "Flagship" : "Dock";
      const startMsg = {
        type: "system" as const,
        subtype: "commander-status" as const,
        content: `Starting ${roleLabel} session...`,
        timestamp: Date.now(),
      };
      manager.addToHistory(fleetId, startMsg);
      broadcast({
        type: `${role}:stream`,
        data: { fleetId, message: startMsg },
      });
    } finally {
      launchingCommanders.delete(launchKey);
    }
  }
  manager.send(fleetId, message, images);
}

function handleCommanderAnswer(
  deps: MessageHandlerDeps,
  data: Record<string, unknown>,
  role: CommanderRole,
): void {
  const { flagshipManager, dockManager, processManager } = deps;
  const manager = role === "flagship" ? flagshipManager : dockManager;
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
    processManager.sendToolResult(processId, toolUseId, answer);
  } else {
    processManager.sendMessage(processId, answer);
  }
}

async function handleCommanderHistory(
  deps: MessageHandlerDeps,
  ws: WebSocket,
  data: Record<string, unknown>,
  role: CommanderRole,
): Promise<void> {
  const { flagshipManager, dockManager, sendTo } = deps;
  const manager = role === "flagship" ? flagshipManager : dockManager;
  const fleetId = data.fleetId as string;
  // Use disk fallback so history is available even after Engine restart
  // (before the Commander process is re-launched by a user message).
  const history = await manager.getHistoryWithDiskFallback(fleetId);
  sendTo(ws, {
    type: `${role}:stream`,
    data: {
      fleetId,
      message: { type: "history", content: JSON.stringify(history) },
    },
  });
}
