/**
 * LaunchEnvironment — type-safe env dict builder for subprocess spawning (ADR-0024).
 *
 * Replaces hand-written Record<string, string> env assembly across
 * ship-manager, escort-manager, commander, and process-manager.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { getAdmiralHome } from "./admiral-home.js";
import type { FleetId, ShipId } from "./context-registry.js";

// ── Ship / Escort environment ──

export interface ShipLaunchEnv {
  VIBE_ADMIRAL: "true";
  VIBE_ADMIRAL_SHIP_ID: ShipId;
  VIBE_ADMIRAL_MAIN_REPO: `${string}/${string}`;
  VIBE_ADMIRAL_ENGINE_PORT: string;
  VIBE_ADMIRAL_FLEET_ID: FleetId;
  VIBE_ADMIRAL_ENV_HASH: string;
}

export interface EscortLaunchEnv extends ShipLaunchEnv {
  VIBE_ADMIRAL_PARENT_SHIP_ID: ShipId;
  VIBE_ADMIRAL_GATE_PROMPT?: string;
  VIBE_ADMIRAL_QA_REQUIRED_PATHS?: string;
  VIBE_ADMIRAL_QA_REQUIRED?: string;
  VIBE_ADMIRAL_ACCEPTANCE_TEST_REQUIRED?: string;
}

// ── Commander environment ──

export interface CommanderLaunchEnv {
  VIBE_ADMIRAL_FLEET_ID: FleetId;
  VIBE_ADMIRAL_DB_PATH: string;
  VIBE_ADMIRAL_ENV_HASH: string;
}

// ── Union type for all launch environments ──

export type LaunchEnvironment = ShipLaunchEnv | EscortLaunchEnv | CommanderLaunchEnv;

// ── Builders ──

export function buildShipEnv(opts: {
  shipId: ShipId;
  repo: `${string}/${string}`;
  fleetId: FleetId;
  enginePort?: string;
}): ShipLaunchEnv {
  const env: ShipLaunchEnv = {
    VIBE_ADMIRAL: "true",
    VIBE_ADMIRAL_SHIP_ID: opts.shipId,
    VIBE_ADMIRAL_MAIN_REPO: opts.repo,
    VIBE_ADMIRAL_ENGINE_PORT: opts.enginePort ?? process.env.ENGINE_PORT ?? "9721",
    VIBE_ADMIRAL_FLEET_ID: opts.fleetId,
    VIBE_ADMIRAL_ENV_HASH: "",
  };
  env.VIBE_ADMIRAL_ENV_HASH = computeEnvHash(env);
  return env;
}

export function buildEscortEnv(opts: {
  escortId: ShipId;
  repo: `${string}/${string}`;
  fleetId: FleetId;
  parentShipId: ShipId;
  gatePrompt?: string;
  enginePort?: string;
  extras?: Record<string, string>;
}): EscortLaunchEnv {
  const env: EscortLaunchEnv = {
    VIBE_ADMIRAL: "true",
    VIBE_ADMIRAL_SHIP_ID: opts.escortId,
    VIBE_ADMIRAL_MAIN_REPO: opts.repo,
    VIBE_ADMIRAL_ENGINE_PORT: opts.enginePort ?? process.env.ENGINE_PORT ?? "9721",
    VIBE_ADMIRAL_FLEET_ID: opts.fleetId,
    VIBE_ADMIRAL_PARENT_SHIP_ID: opts.parentShipId,
    ...(opts.gatePrompt ? { VIBE_ADMIRAL_GATE_PROMPT: opts.gatePrompt } : {}),
    ...(opts.extras ?? {}),
    VIBE_ADMIRAL_ENV_HASH: "",
  } as EscortLaunchEnv;
  env.VIBE_ADMIRAL_ENV_HASH = computeEnvHash(env);
  return env;
}

export function buildCommanderEnv(opts: {
  fleetId: FleetId;
}): CommanderLaunchEnv {
  const env: CommanderLaunchEnv = {
    VIBE_ADMIRAL_FLEET_ID: opts.fleetId,
    VIBE_ADMIRAL_DB_PATH: join(getAdmiralHome(), "fleet.db"),
    VIBE_ADMIRAL_ENV_HASH: "",
  };
  env.VIBE_ADMIRAL_ENV_HASH = computeEnvHash(env);
  return env;
}

// ── Hash verification ──

function computeEnvHash(env: LaunchEnvironment): string {
  const entries = Object.entries(env)
    .filter(([k, v]) => k !== "VIBE_ADMIRAL_ENV_HASH" && v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex")
    .slice(0, 16);
}

export function verifyEnvHash(env: LaunchEnvironment): boolean {
  const declared = (env as { VIBE_ADMIRAL_ENV_HASH?: string }).VIBE_ADMIRAL_ENV_HASH;
  if (!declared) return false;
  return computeEnvHash(env) === declared;
}

/**
 * Convert LaunchEnvironment to a flat Record for spreading into spawn env.
 * Strips undefined values.
 */
export function toLaunchRecord(env: LaunchEnvironment): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      record[key] = value;
    }
  }
  return record;
}
