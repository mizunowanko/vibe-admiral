/**
 * Commander API routes: /api/commander-notify, /api/commander-logs
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiDeps, ApiResponse } from "./api-server.js";
import { sendJson, readBody } from "./api-server.js";
import type { HeadsUpNotification, HeadsUpSeverity } from "./types.js";

const VALID_SEVERITIES = new Set<HeadsUpSeverity>(["info", "warning", "urgent"]);

function validateHeadsUpRequest(body: unknown): HeadsUpNotification | string {
  if (typeof body !== "object" || body === null) return "Invalid request body";
  const b = body as Record<string, unknown>;
  if (b.from !== "dock" && b.from !== "flagship") return 'from must be "dock" or "flagship"';
  if (b.to !== "dock" && b.to !== "flagship") return 'to must be "dock" or "flagship"';
  if (b.from === b.to) return "from and to must be different";
  if (typeof b.fleetId !== "string" || !b.fleetId) return "fleetId is required";
  if (typeof b.summary !== "string" || !b.summary) return "summary is required";
  if (!VALID_SEVERITIES.has(b.severity as HeadsUpSeverity)) return 'severity must be "info", "warning", or "urgent"';
  if (typeof b.needsInvestigation !== "boolean") return "needsInvestigation must be a boolean";

  const notification: HeadsUpNotification = {
    from: b.from,
    to: b.to,
    fleetId: b.fleetId,
    summary: b.summary,
    severity: b.severity as HeadsUpSeverity,
    needsInvestigation: b.needsInvestigation,
  };
  if (typeof b.shipId === "string") notification.shipId = b.shipId;
  if (typeof b.issueNumber === "number" && Number.isInteger(b.issueNumber)) notification.issueNumber = b.issueNumber;
  return notification;
}

/** POST /api/commander-notify — Commander-to-Commander heads-up notification */
export async function handleCommanderNotify(
  deps: ApiDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const rawBody = await readBody(req);
  let body: unknown;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
    return;
  }

  const notification = validateHeadsUpRequest(body);
  if (typeof notification === "string") {
    sendJson(res, 400, { ok: false, error: notification });
    return;
  }

  const delivered = deps.deliverHeadsUp(notification);
  if (!delivered) {
    sendJson(res, 503, { ok: false, error: `Target commander (${notification.to}) is not running for fleet ${notification.fleetId}` });
    return;
  }

  sendJson(res, 200, { ok: true });
}

/** GET /api/commander-logs — Commander chat history (for Dock↔Flagship cross-read) */
export async function handleCommanderLogs(
  deps: ApiDeps,
  req: IncomingMessage,
  res: ServerResponse,
  fleetId: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const role = url.searchParams.get("role");
  if (role !== "flagship" && role !== "dock") {
    sendJson(res, 400, { ok: false, error: 'role query parameter is required and must be "flagship" or "dock"' });
    return;
  }

  const fleets = await deps.loadFleets();
  if (!fleets.find((f) => f.id === fleetId)) {
    sendJson(res, 400, { ok: false, error: `Fleet not found: ${fleetId}` });
    return;
  }

  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
  const logs = await deps.getCommanderHistory(role, fleetId);
  const trimmed = logs.slice(-limit);
  sendJson(res, 200, { ok: true, logs: trimmed, role, fleetId } as ApiResponse & { logs: unknown[]; role: string; fleetId: string });
}
