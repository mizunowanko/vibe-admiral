import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { FlagshipRequestHandler } from "./bridge-request-handler.js";
import type { FleetDatabase } from "./db.js";
import type { ShipManager } from "./ship-manager.js";
import type { EscortManager } from "./escort-manager.js";
import type { ShipActorManager } from "./ship-actor-manager.js";
import type { FlagshipRequest, FleetRepo, FleetSkillSources, Phase, GatePhase } from "./types.js";
import { isGatePhase, DEFAULT_GATE_TYPES, GATE_PREV_PHASE, PHASE_ORDER } from "./types.js";

/** Admiral repo's skills/ directory, resolved from Engine's own source location. */
const ADMIRAL_SKILLS_DIR = join(import.meta.dirname, "..", "..", "skills");

const REPO_PATTERN = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

interface ApiDeps {
  requestHandler: FlagshipRequestHandler;
  getDatabase: () => FleetDatabase | null;
  getShipManager: () => ShipManager;
  getEscortManager: () => EscortManager;
  getActorManager: () => ShipActorManager;
  loadFleets: () => Promise<Array<{
    id: string;
    repos: FleetRepo[];
    skillSources?: FleetSkillSources;
    sharedRulePaths?: string[];
    shipRulePaths?: string[];
    maxConcurrentSorties?: number;
  }>>;
  loadRules: (paths: string[]) => Promise<string>;
  broadcastRequestResult: (fleetId: string, result: string) => void;
}

interface ApiResponse {
  ok: boolean;
  result?: string;
  error?: string;
  phase?: string;
  transitions?: Array<Record<string, unknown>>;
  ships?: unknown[];
}

function validateSortieRequest(body: unknown): FlagshipRequest | string {
  if (typeof body !== "object" || body === null) return "Invalid request body";
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.items) || b.items.length === 0) return "items must be a non-empty array";
  const items: Array<{ repo: string; issueNumber: number; skill?: string }> = [];
  for (const item of b.items) {
    if (typeof item !== "object" || item === null) return "Each item must be an object";
    const it = item as Record<string, unknown>;
    if (typeof it.repo !== "string" || !REPO_PATTERN.test(it.repo)) return `Invalid repo format: ${it.repo}`;
    if (typeof it.issueNumber !== "number" || !Number.isInteger(it.issueNumber) || it.issueNumber <= 0) return `Invalid issueNumber: ${it.issueNumber}`;
    const entry: { repo: string; issueNumber: number; skill?: string } = {
      repo: it.repo,
      issueNumber: it.issueNumber,
    };
    if (typeof it.skill === "string") entry.skill = it.skill;
    items.push(entry);
  }
  return { request: "sortie", items };
}

function validateShipStopRequest(body: unknown): FlagshipRequest | string {
  if (typeof body !== "object" || body === null) return "Invalid request body";
  const b = body as Record<string, unknown>;
  if (typeof b.shipId !== "string" || !b.shipId) return "shipId is required";
  return { request: "ship-stop", shipId: b.shipId };
}

function validateShipResumeRequest(body: unknown): FlagshipRequest | string {
  if (typeof body !== "object" || body === null) return "Invalid request body";
  const b = body as Record<string, unknown>;
  if (typeof b.shipId !== "string" || !b.shipId) return "shipId is required";
  return { request: "ship-resume", shipId: b.shipId };
}

function validateShipAbandonRequest(body: unknown): FlagshipRequest | string {
  if (typeof body !== "object" || body === null) return "Invalid request body";
  const b = body as Record<string, unknown>;
  if (typeof b.shipId !== "string" || !b.shipId) return "shipId is required";
  return { request: "ship-abandon", shipId: b.shipId };
}

function validateShipDeleteRequest(body: unknown): FlagshipRequest | string {
  if (typeof body !== "object" || body === null) return "Invalid request body";
  const b = body as Record<string, unknown>;
  if (typeof b.shipId !== "string" || !b.shipId) return "shipId is required";
  return { request: "ship-delete", shipId: b.shipId };
}

function validatePRReviewResultRequest(body: unknown): FlagshipRequest | string {
  if (typeof body !== "object" || body === null) return "Invalid request body";
  const b = body as Record<string, unknown>;
  if (typeof b.shipId !== "string" || !b.shipId) return "shipId is required";
  if (typeof b.prNumber !== "number" || !Number.isInteger(b.prNumber) || b.prNumber <= 0) return "prNumber must be a positive integer";
  if (b.verdict !== "approve" && b.verdict !== "request-changes") return 'verdict must be "approve" or "request-changes"';
  const result: FlagshipRequest = {
    request: "pr-review-result",
    shipId: b.shipId,
    prNumber: b.prNumber,
    verdict: b.verdict,
  };
  if (typeof b.comments === "string") {
    (result as Extract<FlagshipRequest, { request: "pr-review-result" }>).comments = b.comments;
  }
  return result;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: ApiResponse): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function resolveFleetContext(deps: ApiDeps, fleetId?: string): Promise<{
  fleetId: string;
  fleetRepos: FleetRepo[];
  repoRemotes: string[];
  skillSources?: FleetSkillSources;
  shipExtraPrompt?: string;
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
    return "Multiple fleets exist — fleetId is required";
  }
  const fleetRepos = fleet.repos;
  const repoRemotes = fleetRepos.map((r) => r.remote).filter((r): r is string => r !== undefined);
  const sharedRules = await deps.loadRules(fleet.sharedRulePaths ?? []);
  const shipRules = await deps.loadRules(fleet.shipRulePaths ?? []);
  const shipExtraPrompt = [sharedRules, shipRules].filter(Boolean).join("\n\n") || undefined;
  return {
    fleetId: fleet.id,
    fleetRepos,
    repoRemotes,
    skillSources: { ...fleet.skillSources, admiralSkillsDir: ADMIRAL_SKILLS_DIR },
    shipExtraPrompt,
    maxConcurrentSorties: fleet.maxConcurrentSorties,
  };
}

// === Ship/Escort API route handler ===

async function handleShipRoute(
  deps: ApiDeps,
  req: IncomingMessage,
  res: ServerResponse,
  shipId: string,
  action: string,
): Promise<void> {
  const db = deps.getDatabase();
  if (!db) {
    sendJson(res, 503, { ok: false, error: "Database not initialized" });
    return;
  }

  const shipManager = deps.getShipManager();

  // GET /api/ship/:shipId/phase — poll current phase
  if (action === "phase" && req.method === "GET") {
    const ship = db.getShipById(shipId);
    if (!ship) {
      sendJson(res, 404, { ok: false, error: `Ship ${shipId} not found` });
      return;
    }
    sendJson(res, 200, { ok: true, phase: ship.phase });
    return;
  }

  // GET /api/ship/:shipId/phase-transition-log — get recent phase transitions
  if (action === "phase-transition-log" && req.method === "GET") {
    const ship = db.getShipById(shipId);
    if (!ship) {
      sendJson(res, 404, { ok: false, error: `Ship ${shipId} not found` });
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const limit = Math.min(Number(url.searchParams.get("limit")) || 10, 100);
    const transitions = db.getPhaseTransitions(shipId, limit);
    sendJson(res, 200, { ok: true, transitions });
    return;
  }

  // DELETE /api/ship/:shipId/delete — Force-delete a Ship (zombie cleanup)
  if (action === "delete" && req.method === "DELETE") {
    const deleted = shipManager.deleteShip(shipId);
    if (deleted) {
      sendJson(res, 200, { ok: true });
    } else {
      sendJson(res, 404, { ok: false, error: `Ship ${shipId} not found` });
    }
    return;
  }

  // POST-only routes below
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const rawBody = await readBody(req);
  let body: Record<string, unknown>;
  try {
    body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
  } catch {
    sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
    return;
  }

  // POST /api/ship/:shipId/phase-transition — Ship transitions its own phase
  if (action === "phase-transition") {
    const targetPhase = body.phase as string | undefined;
    if (!targetPhase) {
      sendJson(res, 400, { ok: false, error: "phase is required" });
      return;
    }
    if (!PHASE_ORDER.includes(targetPhase as Phase)) {
      sendJson(res, 400, { ok: false, error: `Invalid phase: ${targetPhase}` });
      return;
    }

    const ship = db.getShipById(shipId);
    if (!ship) {
      sendJson(res, 404, { ok: false, error: `Ship ${shipId} not found` });
      return;
    }

    const metadata = (body.metadata as Record<string, unknown>) ?? {};
    const triggeredBy = (body.triggeredBy as string) ?? "ship";

    // Determine the XState event based on target phase
    const actorManager = deps.getActorManager();
    let xstateEvent: import("./ship-machine.js").ShipMachineEvent;
    if (isGatePhase(targetPhase as Phase)) {
      xstateEvent = { type: "GATE_ENTER" };
    } else if (targetPhase === "done") {
      xstateEvent = { type: "COMPLETE" };
    } else {
      // For non-gate, non-done transitions requested by Ship (shouldn't normally happen)
      sendJson(res, 400, { ok: false, error: `Ships can only transition to gate phases or done, not ${targetPhase}` });
      return;
    }

    // XState is the sole authority: request transition through XState first
    const result = actorManager.requestTransition(shipId, xstateEvent);
    if (!result.success) {
      sendJson(res, 409, { ok: false, error: `Transition rejected by XState: current phase is ${result.currentPhase ?? "unknown"}, cannot process ${xstateEvent.type}` });
      return;
    }

    // XState approved — persist to DB
    try {
      db.persistPhaseTransition(
        shipId,
        result.fromPhase,
        result.toPhase,
        triggeredBy,
        metadata,
      );
    } catch (err) {
      console.error(`[api-server] DB persist failed after XState transition for Ship ${shipId.slice(0, 8)}...:`, err);
      // DB failed but XState already transitioned — log and continue
    }

    shipManager.syncPhaseFromDb(shipId);

    // Handle gate-specific side effects
    if (isGatePhase(result.toPhase)) {
      const gatePhase = result.toPhase as GatePhase;
      const gateType = DEFAULT_GATE_TYPES[gatePhase];
      shipManager.setGateCheck(shipId, gatePhase, gateType);

      // Launch Escort if not already running
      const escortManager = deps.getEscortManager();
      if (!escortManager.isEscortRunning(shipId)) {
        const escortId = escortManager.launchEscort(shipId, gatePhase, gateType);
        if (!escortId) {
          // Escort launch failed — revert via XState ESCORT_DIED
          const prevPhase = GATE_PREV_PHASE[gatePhase];
          console.error(
            `[api-server] Escort launch failed for Ship ${shipId.slice(0, 8)}... — reverting from ${gatePhase} to ${prevPhase}`,
          );
          const revertResult = actorManager.requestTransition(shipId, {
            type: "ESCORT_DIED",
            exitCode: null,
            feedback: "Escort launch failed — reverting to pre-gate phase for retry",
          });
          if (revertResult.success) {
            try {
              db.persistPhaseTransition(shipId, revertResult.fromPhase, revertResult.toPhase, "engine", {
                gate_result: "rejected",
                feedback: "Escort launch failed — reverting to pre-gate phase for retry",
              });
            } catch (revertErr) {
              console.error(`[api-server] DB persist failed for revert on Ship ${shipId.slice(0, 8)}...:`, revertErr);
            }
            shipManager.syncPhaseFromDb(shipId);
          }
          shipManager.clearGateCheck(shipId);
          sendJson(res, 500, { ok: false, error: "Escort launch failed — phase reverted to allow retry" });
          return;
        }
      }
    }

    sendJson(res, 200, { ok: true, phase: result.toPhase });
    return;
  }

  // POST /api/ship/:shipId/gate-verdict — Escort submits gate result
  if (action === "gate-verdict") {
    const verdict = body.verdict as string | undefined;
    if (verdict !== "approve" && verdict !== "reject") {
      sendJson(res, 400, { ok: false, error: 'verdict must be "approve" or "reject"' });
      return;
    }

    const ship = db.getShipById(shipId);
    if (!ship) {
      sendJson(res, 404, { ok: false, error: `Ship ${shipId} not found` });
      return;
    }

    const currentPhase = ship.phase as Phase;
    if (!isGatePhase(currentPhase)) {
      sendJson(res, 400, { ok: false, error: `Ship is not in a gate phase (current: ${currentPhase})` });
      return;
    }

    const feedback = body.feedback as string | undefined;

    // XState is the sole authority: request transition through XState first
    const actorManager = deps.getActorManager();
    const xstateEvent: import("./ship-machine.js").ShipMachineEvent = verdict === "approve"
      ? { type: "GATE_APPROVED" }
      : { type: "GATE_REJECTED", feedback: feedback ?? "" };

    const result = actorManager.requestTransition(shipId, xstateEvent);
    if (!result.success) {
      sendJson(res, 409, { ok: false, error: `Gate verdict rejected by XState: current phase is ${result.currentPhase ?? "unknown"}` });
      return;
    }

    // XState approved — persist to DB
    const metadata: Record<string, unknown> = verdict === "approve"
      ? { gate_result: "approved" }
      : { gate_result: "rejected", feedback: feedback ?? "" };

    try {
      db.persistPhaseTransition(shipId, result.fromPhase, result.toPhase, "escort", metadata);
    } catch (err) {
      console.error(`[api-server] DB persist failed after gate verdict for Ship ${shipId.slice(0, 8)}...:`, err);
    }

    shipManager.syncPhaseFromDb(shipId);
    shipManager.clearGateCheck(shipId);

    sendJson(res, 200, { ok: true, phase: result.toPhase });
    return;
  }

  // POST /api/ship/:shipId/nothing-to-do — Ship declares nothing to do
  if (action === "nothing-to-do") {
    const reason = (body.reason as string) ?? "No reason provided";
    const ship = db.getShipById(shipId);
    if (!ship) {
      sendJson(res, 404, { ok: false, error: `Ship ${shipId} not found` });
      return;
    }

    // XState is the sole authority: request transition through XState first
    const actorManager = deps.getActorManager();
    const result = actorManager.requestTransition(shipId, { type: "NOTHING_TO_DO", reason });
    if (!result.success) {
      sendJson(res, 409, { ok: false, error: `Nothing-to-do rejected by XState: current phase is ${result.currentPhase ?? "unknown"}` });
      return;
    }

    // XState approved — persist to DB
    try {
      db.persistPhaseTransition(shipId, result.fromPhase, result.toPhase, "ship", { reason, nothingToDo: true });
    } catch (err) {
      console.error(`[api-server] DB persist failed after nothing-to-do for Ship ${shipId.slice(0, 8)}...:`, err);
    }

    shipManager.syncPhaseFromDb(shipId);
    sendJson(res, 200, { ok: true, phase: "done" });
    return;
  }

  // POST /api/ship/:shipId/abandon — Abandon a stopped Ship (transition to done)
  if (action === "abandon") {
    const ship = db.getShipById(shipId);
    if (!ship) {
      sendJson(res, 404, { ok: false, error: `Ship ${shipId} not found` });
      return;
    }

    if (ship.phase !== "stopped") {
      sendJson(res, 400, { ok: false, error: `Ship must be in "stopped" phase to abandon (current: ${ship.phase})` });
      return;
    }

    const abandoned = shipManager.abandonShip(shipId);
    if (abandoned) {
      sendJson(res, 200, { ok: true, phase: "done" });
    } else {
      sendJson(res, 400, { ok: false, error: "Failed to abandon ship" });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: `Unknown ship action: ${action}` });
}

export function createApiHandler(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse) => void {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    // Only handle /api/* routes
    if (!path.startsWith("/api/")) {
      sendJson(res, 404, { ok: false, error: "Not found" });
      return;
    }

    const route = path.slice(5); // strip "/api/"

    try {
      // === Ship/Escort API endpoints ===
      // Pattern: /api/ship/:shipId/<action>
      const shipRouteMatch = route.match(/^ship\/([^/]+)\/(.+)$/);
      if (shipRouteMatch) {
        const [, shipId, action] = shipRouteMatch;
        await handleShipRoute(deps, req, res, shipId!, action!);
        return;
      }

      // === Frontend API endpoints ===

      // GET /api/ships — Ship list as JSON array (for Frontend)
      if (route === "ships" && req.method === "GET") {
        const fleetId = url.searchParams.get("fleetId") ?? undefined;
        const shipManager = deps.getShipManager();
        const ships = fleetId
          ? shipManager.getShipsByFleet(fleetId)
          : shipManager.getAllShips();
        sendJson(res, 200, { ok: true, ships });
        return;
      }

      // === Flagship API endpoints (legacy routes) ===

      // GET /api/ship-status
      if (route === "ship-status" && req.method === "GET") {
        const fleetId = url.searchParams.get("fleetId") ?? undefined;
        const ctx = await resolveFleetContext(deps, fleetId);
        if (typeof ctx === "string") {
          sendJson(res, 400, { ok: false, error: ctx });
          return;
        }
        const result = await deps.requestHandler.handle(
          ctx.fleetId,
          { request: "ship-status" },
          ctx.fleetRepos,
          ctx.repoRemotes,
        );
        deps.broadcastRequestResult(ctx.fleetId, result);
        sendJson(res, 200, { ok: true, result });
        return;
      }

      // Check if route is a known POST endpoint
      const postRoutes = new Set(["sortie", "ship-stop", "ship-resume", "ship-abandon", "ship-delete", "pr-review-result"]);
      if (!postRoutes.has(route)) {
        sendJson(res, 404, { ok: false, error: `Unknown endpoint: /api/${route}` });
        return;
      }

      // POST endpoints only
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }

      const rawBody = await readBody(req);
      let body: unknown;
      try {
        body = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
        return;
      }

      const bodyObj = body as Record<string, unknown>;
      const fleetId = (bodyObj.fleetId as string | undefined) ?? undefined;
      const ctx = await resolveFleetContext(deps, fleetId);
      if (typeof ctx === "string") {
        sendJson(res, 400, { ok: false, error: ctx });
        return;
      }

      let request: FlagshipRequest | string;

      switch (route) {
        case "sortie":
          request = validateSortieRequest(body);
          break;
        case "ship-stop":
          request = validateShipStopRequest(body);
          break;
        case "ship-resume":
          request = validateShipResumeRequest(body);
          break;
        case "ship-abandon":
          request = validateShipAbandonRequest(body);
          break;
        case "ship-delete":
          request = validateShipDeleteRequest(body);
          break;
        case "pr-review-result":
          request = validatePRReviewResultRequest(body);
          break;
        default:
          sendJson(res, 404, { ok: false, error: `Unknown endpoint: /api/${route}` });
          return;
      }

      if (typeof request === "string") {
        sendJson(res, 400, { ok: false, error: request });
        return;
      }

      const result = await deps.requestHandler.handle(
        ctx.fleetId,
        request,
        ctx.fleetRepos,
        ctx.repoRemotes,
        ctx.skillSources,
        ctx.shipExtraPrompt,
        ctx.maxConcurrentSorties,
      );

      deps.broadcastRequestResult(ctx.fleetId, result);
      sendJson(res, 200, { ok: true, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[api-server] Error handling ${path}:`, message);
      sendJson(res, 500, { ok: false, error: message });
    }
  };
}
