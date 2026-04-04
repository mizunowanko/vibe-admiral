/**
 * API Server — Thin routing orchestrator.
 *
 * All domain logic lives in dedicated modules:
 *   - ship-internal-api.ts  — /api/ship/:shipId/* (Ship/Escort internal)
 *   - ship-api.ts           — /api/ships, /api/ship-status, /api/sortie, etc.
 *   - dispatch-api.ts       — /api/dispatch, /api/dispatches
 *   - commander-api.ts      — /api/commander-notify, /api/commander-logs
 *   - system-api.ts         — /api/restart, /api/resume-all
 *
 * fleetId validation is centralized via fleet-middleware.ts.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { FlagshipRequestHandler } from "./bridge-request-handler.js";
import type { FleetDatabase } from "./db.js";
import type { ShipManager } from "./ship-manager.js";
import type { EscortManager } from "./escort-manager.js";
import type { ShipActorManager } from "./ship-actor-manager.js";
import type { DispatchManager } from "./dispatch-manager.js";
import type { FleetRepo, FleetSkillSources, CustomInstructions, GatePhase, AdmiralSettings, HeadsUpNotification, ResumeAllUnitResult } from "./types.js";
import { mergeSettings } from "./deep-merge.js";
import { extractFleetId, sendFleetIdRequired } from "./fleet-middleware.js";
import { handleShipRoute } from "./ship-internal-api.js";
import { handleShipList, handleShipById, handleShipStatus, handleShipOperation } from "./ship-api.js";
import { handleDispatchCreate, handleDispatchList } from "./dispatch-api.js";
import { handleCommanderNotify, handleCommanderLogs } from "./commander-api.js";
import { handleRestart, handleResumeAll } from "./system-api.js";

// Re-export notifyPhaseWaiters from ship-internal-api for ship-lifecycle.ts
export { notifyPhaseWaiters } from "./ship-internal-api.js";

/** Admiral repo's skills/ directory, resolved from Engine's own source location. */
const ADMIRAL_SKILLS_DIR = join(import.meta.dirname, "..", "..", "skills");

export interface ApiDeps {
  requestHandler: FlagshipRequestHandler;
  getDatabase: () => FleetDatabase | null;
  getShipManager: () => ShipManager;
  getDispatchManager: () => DispatchManager;
  getEscortManager: () => EscortManager;
  getActorManager: () => ShipActorManager;
  getCommanderHistory: (role: "flagship" | "dock", fleetId: string) => Promise<import("./types.js").StreamMessage[]>;
  loadFleets: () => Promise<Array<{
    id: string;
    name: string;
    repos: FleetRepo[];
    skillSources?: FleetSkillSources;
    sharedRulePaths?: string[];
    shipRulePaths?: string[];
    customInstructions?: CustomInstructions;
    gates?: import("./types.js").FleetGateSettings;
    gatePrompts?: Partial<Record<import("./types.js").GateType, string>>;
    qaRequiredPaths?: string[];
    acceptanceTestRequired?: boolean;
    maxConcurrentSorties?: number;
  }>>;
  loadRules: (paths: string[]) => Promise<string>;
  loadAdmiralSettings: () => Promise<AdmiralSettings>;
  broadcastRequestResult: (fleetId: string, result: string) => void;
  notifyGateSkip: (shipId: string, gatePhase: GatePhase, reason: string) => void;
  deliverHeadsUp: (notification: HeadsUpNotification) => boolean;
  resumeAllUnits: () => Promise<ResumeAllUnitResult[]>;
  requestRestart: () => void;
}

export interface ApiResponse {
  ok: boolean;
  result?: string;
  error?: string;
  phase?: string;
  transitions?: Array<Record<string, unknown>>;
  ships?: unknown[];
  results?: ResumeAllUnitResult[];
  summary?: { resumed: number; skipped: number; errors: number };
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export function sendJson(res: ServerResponse, status: number, data: ApiResponse): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export async function resolveFleetContext(deps: ApiDeps, fleetId?: string): Promise<{
  fleetId: string;
  fleetRepos: FleetRepo[];
  repoRemotes: string[];
  skillSources?: FleetSkillSources;
  shipExtraPrompt?: string;
  customInstructionsText?: string;
  maxConcurrentSorties?: number;
} | string> {
  const fleets = await deps.loadFleets();
  let fleet;
  if (fleetId) {
    fleet = fleets.find((f) => f.id === fleetId);
    if (!fleet) return `Fleet not found: ${fleetId}`;
  } else if (fleets.length === 1) {
    fleet = fleets[0]!;
  } else if (fleets.length === 0) {
    return "No fleets configured";
  } else {
    const fleetList = fleets.map((f) => `  - ${f.id} (${f.name})`).join("\n");
    return `Multiple fleets exist — fleetId is required. Available fleets:\n${fleetList}`;
  }
  const fleetRepos = fleet.repos;
  const repoRemotes = fleetRepos.map((r) => r.remote).filter((r): r is string => r !== undefined);
  const sharedRules = await deps.loadRules(fleet.sharedRulePaths ?? []);
  const shipRules = await deps.loadRules(fleet.shipRulePaths ?? []);

  const admiralSettings = await deps.loadAdmiralSettings();
  const merged = mergeSettings(admiralSettings.global, {
    customInstructions: fleet.customInstructions,
    gates: fleet.gates,
    gatePrompts: fleet.gatePrompts,
    qaRequiredPaths: fleet.qaRequiredPaths,
    maxConcurrentSorties: fleet.maxConcurrentSorties,
  });

  const ci = merged.customInstructions;
  const ciParts = [ci?.shared, ci?.ship].filter(Boolean);
  const ciText = ciParts.length > 0 ? `## Custom Instructions\n\n${ciParts.join("\n\n")}` : undefined;
  const shipExtraPrompt = [sharedRules, shipRules, ciText].filter(Boolean).join("\n\n") || undefined;
  return {
    fleetId: fleet.id,
    fleetRepos,
    repoRemotes,
    skillSources: { ...fleet.skillSources, admiralSkillsDir: ADMIRAL_SKILLS_DIR },
    shipExtraPrompt,
    customInstructionsText: ciText,
    maxConcurrentSorties: merged.maxConcurrentSorties,
  };
}

export function createApiHandler(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse) => void {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    if (!path.startsWith("/api/")) {
      sendJson(res, 404, { ok: false, error: "Not found" });
      return;
    }

    const route = path.slice(5); // strip "/api/"

    try {
      // === Ship/Escort internal API (fleetId exempt) ===
      const shipRouteMatch = route.match(/^ship\/([^/]+)\/(.+)$/);
      if (shipRouteMatch) {
        const [, shipId, action] = shipRouteMatch;
        await handleShipRoute(deps, req, res, shipId!, action!);
        return;
      }

      // === System endpoints (fleetId exempt) ===
      if (route === "restart" && req.method === "POST") {
        await handleRestart(deps, req, res);
        return;
      }
      if (route === "resume-all" && req.method === "POST") {
        await handleResumeAll(deps, req, res);
        return;
      }

      // === Commander-notify has fleetId in body, validated by its own handler ===
      if (route === "commander-notify" && req.method === "POST") {
        await handleCommanderNotify(deps, req, res);
        return;
      }

      // === All remaining routes require fleetId ===

      // For POST routes, we need to peek at the body to extract fleetId
      let parsedBody: Record<string, unknown> | undefined;
      if (req.method === "POST") {
        const rawBody = await readBody(req);
        try {
          parsedBody = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
        } catch {
          sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
          return;
        }
      }

      let fleetId = extractFleetId(url, req.method ?? "GET", parsedBody);
      if (!fleetId) {
        // Auto-resolve when a single fleet exists
        const fleets = await deps.loadFleets();
        if (fleets.length === 1) {
          fleetId = fleets[0]!.id;
        } else if (fleets.length === 0) {
          sendJson(res, 400, { ok: false, error: "No fleets configured" });
          return;
        } else {
          sendFleetIdRequired(res);
          return;
        }
      }

      // === Dispatch API ===
      if (route === "dispatch" && req.method === "POST") {
        await handleDispatchCreate(deps, req, res, fleetId, parsedBody!);
        return;
      }
      if (route === "dispatches" && req.method === "GET") {
        await handleDispatchList(deps, req, res, fleetId);
        return;
      }

      // === Ship list/detail API (Frontend) ===
      if (route === "ships" && req.method === "GET") {
        await handleShipList(deps, req, res, fleetId);
        return;
      }
      const shipByIdMatch = route.match(/^ships\/([^/]+)$/);
      if (shipByIdMatch && req.method === "GET") {
        await handleShipById(deps, req, res, shipByIdMatch[1]!, fleetId);
        return;
      }

      // === Commander logs ===
      if (route === "commander-logs" && req.method === "GET") {
        await handleCommanderLogs(deps, req, res, fleetId);
        return;
      }

      // === Ship status (legacy Flagship) ===
      if (route === "ship-status" && req.method === "GET") {
        await handleShipStatus(deps, req, res, fleetId);
        return;
      }

      // === POST ship operations (legacy Flagship routes) ===
      const postRoutes = new Set(["sortie", "ship-pause", "ship-resume", "ship-abandon", "ship-reactivate", "ship-delete", "pr-review-result"]);
      if (!postRoutes.has(route)) {
        sendJson(res, 404, { ok: false, error: `Unknown endpoint: /api/${route}` });
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }

      await handleShipOperation(deps, req, res, route, fleetId, parsedBody!);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[api-server] Error handling ${path}:`, message);
      sendJson(res, 500, { ok: false, error: message });
    }
  };
}
