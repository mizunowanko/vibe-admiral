import type { IncomingMessage, ServerResponse } from "node:http";
import type { FlagshipRequestHandler } from "./bridge-request-handler.js";
import type { FlagshipRequest, FleetRepo, FleetSkillSources } from "./types.js";

const REPO_PATTERN = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

interface ApiDeps {
  requestHandler: FlagshipRequestHandler;
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
    skillSources: fleet.skillSources,
    shipExtraPrompt,
    maxConcurrentSorties: fleet.maxConcurrentSorties,
  };
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
      const postRoutes = new Set(["sortie", "ship-stop", "ship-resume", "pr-review-result"]);
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
