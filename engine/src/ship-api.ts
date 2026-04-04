/**
 * Ship API routes (Frontend-facing + legacy Flagship routes):
 *   GET  /api/ships, /api/ships/:id, /api/ship-status
 *   POST /api/sortie, /api/ship-pause, /api/ship-resume,
 *        /api/ship-abandon, /api/ship-reactivate, /api/ship-delete,
 *        /api/pr-review-result
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiDeps } from "./api-server.js";
import { sendJson, resolveFleetContext } from "./api-server.js";
import type { FlagshipRequest, CommanderRole } from "./types.js";

const REPO_PATTERN = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

/** Ship write operations that only Flagship may invoke. Dock gets 403. */
const FLAGSHIP_ONLY_ROUTES = new Set([
  "sortie",
  "ship-pause",
  "ship-resume",
  "ship-abandon",
  "ship-reactivate",
  "ship-delete",
  "pr-review-result",
]);

// ── Request validators ──

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

function validateShipPauseRequest(body: unknown): FlagshipRequest | string {
  if (typeof body !== "object" || body === null) return "Invalid request body";
  const b = body as Record<string, unknown>;
  if (typeof b.shipId !== "string" || !b.shipId) return "shipId is required";
  return { request: "ship-pause", shipId: b.shipId };
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

function validateShipReactivateRequest(body: unknown): FlagshipRequest | string {
  if (typeof body !== "object" || body === null) return "Invalid request body";
  const b = body as Record<string, unknown>;
  if (typeof b.shipId !== "string" || !b.shipId) return "shipId is required";
  return { request: "ship-reactivate", shipId: b.shipId };
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

/** GET /api/ships — Ship list as JSON array (for Frontend) */
export async function handleShipList(
  deps: ApiDeps,
  _req: IncomingMessage,
  res: ServerResponse,
  fleetId: string,
): Promise<void> {
  const shipManager = deps.getShipManager();
  const escortManager = deps.getEscortManager();
  const ships = shipManager.getShipsByFleet(fleetId);

  const enriched = ships.map((s) => {
    const isRunning = escortManager.isEscortRunning(s.id);
    if (!isRunning) return s;
    return {
      ...s,
      escorts: [{ id: "escort", phase: "reviewing" as const, processDead: false }],
    };
  });

  sendJson(res, 200, { ok: true, ships: enriched });
}

/** GET /api/ships/:id — Individual Ship data (for Frontend notification→fetch pattern) */
export async function handleShipById(
  deps: ApiDeps,
  _req: IncomingMessage,
  res: ServerResponse,
  shipId: string,
  fleetId: string,
): Promise<void> {
  const shipManager = deps.getShipManager();
  const ship = shipManager.getShip(shipId);
  if (!ship) {
    sendJson(res, 404, { ok: false, error: `Ship ${shipId} not found` });
    return;
  }
  // Validate that the ship belongs to the requested fleet
  if (ship.fleetId !== fleetId) {
    sendJson(res, 404, { ok: false, error: `Ship ${shipId} not found in fleet ${fleetId}` });
    return;
  }
  sendJson(res, 200, { ok: true, ships: [ship] });
}

/** GET /api/ship-status */
export async function handleShipStatus(
  deps: ApiDeps,
  _req: IncomingMessage,
  res: ServerResponse,
  fleetId: string,
): Promise<void> {
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
}

/** POST handler for legacy ship operation routes.
 *  Body is pre-parsed by the router (api-server.ts) for fleetId extraction. */
export async function handleShipOperation(
  deps: ApiDeps,
  _req: IncomingMessage,
  res: ServerResponse,
  route: string,
  fleetId: string,
  body: Record<string, unknown>,
): Promise<void> {
  // Dock cannot invoke Ship write operations (Issue #854)
  const callerRole = body.callerRole as CommanderRole | undefined;
  if (callerRole === "dock" && FLAGSHIP_ONLY_ROUTES.has(route)) {
    sendJson(res, 403, { ok: false, error: "Ship operations are restricted to Flagship" });
    return;
  }

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
    case "ship-pause":
      request = validateShipPauseRequest(body);
      break;
    case "ship-resume":
      request = validateShipResumeRequest(body);
      break;
    case "ship-abandon":
      request = validateShipAbandonRequest(body);
      break;
    case "ship-reactivate":
      request = validateShipReactivateRequest(body);
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
    ctx.customInstructionsText,
  );

  deps.broadcastRequestResult(ctx.fleetId, result);
  sendJson(res, 200, { ok: true, result });
}
