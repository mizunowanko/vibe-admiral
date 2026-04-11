/**
 * Fleet Config API routes: GET /api/fleet-config, PATCH /api/fleet-config
 *
 * Commander (Flagship/Dock) が Fleet 設定を参照・更新するための REST API。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiDeps, ApiResponse } from "./api-server.js";
import { sendJson } from "./api-server.js";
import { loadFleets, saveFleets } from "./api-handlers.js";
import type { CustomInstructions, FleetGateSettings, GateType } from "./types.js";

/** Fields that Commander is allowed to update via PATCH /api/fleet-config. */
const UPDATABLE_FIELDS = new Set([
  "customInstructions",
  "gatePrompts",
  "gates",
  "maxConcurrentSorties",
  "acceptanceTestRequired",
  "qaRequiredPaths",
]);

/** GET /api/fleet-config — Return the current Fleet configuration. */
export async function handleFleetConfigGet(
  _deps: ApiDeps,
  _req: IncomingMessage,
  res: ServerResponse,
  fleetId: string,
): Promise<void> {
  const fleets = await loadFleets();
  const fleet = fleets.find((f) => f.id === fleetId);
  if (!fleet) {
    sendJson(res, 404, { ok: false, error: `Fleet not found: ${fleetId}` });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    fleet: {
      id: fleet.id,
      name: fleet.name,
      repos: fleet.repos,
      customInstructions: fleet.customInstructions,
      gates: fleet.gates,
      gatePrompts: fleet.gatePrompts,
      qaRequiredPaths: fleet.qaRequiredPaths,
      acceptanceTestRequired: fleet.acceptanceTestRequired,
      maxConcurrentSorties: fleet.maxConcurrentSorties,
    },
  } as ApiResponse & { fleet: unknown });
}

/** PATCH /api/fleet-config — Partially update Fleet configuration. */
export async function handleFleetConfigPatch(
  deps: ApiDeps,
  _req: IncomingMessage,
  res: ServerResponse,
  fleetId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const fleets = await loadFleets();
  const fleet = fleets.find((f) => f.id === fleetId);
  if (!fleet) {
    sendJson(res, 404, { ok: false, error: `Fleet not found: ${fleetId}` });
    return;
  }

  // Validate: only allow known updatable fields
  const updateKeys = Object.keys(body).filter((k) => k !== "fleetId");
  const unknownKeys = updateKeys.filter((k) => !UPDATABLE_FIELDS.has(k));
  if (unknownKeys.length > 0) {
    sendJson(res, 400, { ok: false, error: `Unknown or non-updatable fields: ${unknownKeys.join(", ")}` });
    return;
  }

  if (updateKeys.length === 0) {
    sendJson(res, 400, { ok: false, error: "No fields to update" });
    return;
  }

  // Apply updates
  if (body.customInstructions !== undefined) {
    if (typeof body.customInstructions !== "object" || body.customInstructions === null || Array.isArray(body.customInstructions)) {
      sendJson(res, 400, { ok: false, error: "customInstructions must be an object" });
      return;
    }
    fleet.customInstructions = body.customInstructions as CustomInstructions;
  }
  if (body.gatePrompts !== undefined) {
    if (typeof body.gatePrompts !== "object" || body.gatePrompts === null || Array.isArray(body.gatePrompts)) {
      sendJson(res, 400, { ok: false, error: "gatePrompts must be an object" });
      return;
    }
    fleet.gatePrompts = body.gatePrompts as Partial<Record<GateType, string>>;
  }
  if (body.gates !== undefined) {
    if (typeof body.gates !== "object" || body.gates === null || Array.isArray(body.gates)) {
      sendJson(res, 400, { ok: false, error: "gates must be an object" });
      return;
    }
    fleet.gates = body.gates as FleetGateSettings;
  }
  if (body.maxConcurrentSorties !== undefined) {
    const val = body.maxConcurrentSorties;
    if (typeof val !== "number" || !Number.isInteger(val) || val < 1) {
      sendJson(res, 400, { ok: false, error: "maxConcurrentSorties must be a positive integer" });
      return;
    }
    fleet.maxConcurrentSorties = val;
  }
  if (body.acceptanceTestRequired !== undefined) {
    if (typeof body.acceptanceTestRequired !== "boolean") {
      sendJson(res, 400, { ok: false, error: "acceptanceTestRequired must be a boolean" });
      return;
    }
    fleet.acceptanceTestRequired = body.acceptanceTestRequired;
  }
  if (body.qaRequiredPaths !== undefined) {
    if (!Array.isArray(body.qaRequiredPaths) || !body.qaRequiredPaths.every((p) => typeof p === "string")) {
      sendJson(res, 400, { ok: false, error: "qaRequiredPaths must be an array of strings" });
      return;
    }
    fleet.qaRequiredPaths = body.qaRequiredPaths as string[];
  }

  await saveFleets(fleets);

  // Notify running Commanders about the config change
  const changedFields = updateKeys.join(", ");
  deps.deliverHeadsUp({
    from: "flagship",
    to: "dock",
    fleetId,
    summary: `Fleet 設定が更新されました（${changedFields}）。次のターンで最新設定を反映してください。`,
    severity: "info",
    needsInvestigation: false,
  });
  deps.deliverHeadsUp({
    from: "dock",
    to: "flagship",
    fleetId,
    summary: `Fleet 設定が更新されました（${changedFields}）。次のターンで最新設定を反映してください。`,
    severity: "info",
    needsInvestigation: false,
  });

  sendJson(res, 200, {
    ok: true,
    result: `Fleet config updated: ${changedFields}`,
    fleet: {
      id: fleet.id,
      name: fleet.name,
      customInstructions: fleet.customInstructions,
      gates: fleet.gates,
      gatePrompts: fleet.gatePrompts,
      qaRequiredPaths: fleet.qaRequiredPaths,
      acceptanceTestRequired: fleet.acceptanceTestRequired,
      maxConcurrentSorties: fleet.maxConcurrentSorties,
    },
  } as ApiResponse & { fleet: unknown });
}
