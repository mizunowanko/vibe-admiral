import type { ServerResponse } from "node:http";

/**
 * Extract and validate fleetId from request.
 *
 * - GET requests: reads `fleetId` from query parameter
 * - POST requests: reads `fleetId` from parsed JSON body
 *
 * Returns the fleetId string, or null if missing (caller should respond 400).
 */
export function extractFleetId(
  url: URL,
  method: string,
  body?: Record<string, unknown>,
): string | null {
  if (method === "GET" || method === "DELETE") {
    const fleetId = url.searchParams.get("fleetId");
    return fleetId || null;
  }
  // POST / PUT / PATCH — read from body
  const fleetId = body?.fleetId;
  return typeof fleetId === "string" && fleetId ? fleetId : null;
}

/**
 * Routes that are exempt from fleetId validation.
 * System endpoints and Ship-internal APIs (scoped by shipId) don't need fleetId.
 */
const FLEET_ID_EXEMPT_PREFIXES = [
  "restart",
  "resume-all",
  "ship/", // /api/ship/:shipId/* — Ship-internal API (scoped by shipId)
];

export function isFleetIdExempt(route: string): boolean {
  return FLEET_ID_EXEMPT_PREFIXES.some((prefix) => route.startsWith(prefix));
}

/**
 * Send a 400 JSON response for missing fleetId.
 */
export function sendFleetIdRequired(res: ServerResponse): void {
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "fleetId is required" }));
}
