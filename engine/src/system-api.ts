/**
 * System API routes: /api/restart, /api/resume-all
 *
 * These endpoints are fleet-independent and exempt from fleetId validation.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiDeps } from "./api-server.js";
import { sendJson } from "./api-server.js";

/** POST /api/restart — Restart Engine + Frontend */
export async function handleRestart(
  deps: ApiDeps,
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  sendJson(res, 200, { ok: true, result: "Restart initiated" });
  setImmediate(() => deps.requestRestart());
}

/** POST /api/resume-all — Resume all paused/dead Units across all Fleets */
export async function handleResumeAll(
  deps: ApiDeps,
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const results = await deps.resumeAllUnits();
  const resumed = results.filter(r => r.status === "resumed");
  const skipped = results.filter(r => r.status === "skipped");
  const errors = results.filter(r => r.status === "error");
  sendJson(res, 200, { ok: true, results, summary: { resumed: resumed.length, skipped: skipped.length, errors: errors.length } });
}
