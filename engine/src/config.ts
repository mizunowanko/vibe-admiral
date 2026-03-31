/**
 * Centralized environment configuration for the Engine.
 *
 * Reads ADMIRAL_ENV (preferred) or falls back to NODE_ENV.
 * All modules should import from here instead of reading process.env directly.
 */

export type AdmiralEnv = "development" | "production";

function resolveEnv(): AdmiralEnv {
  if (process.env.ADMIRAL_ENV === "production") return "production";
  if (process.env.ADMIRAL_ENV === "development") return "development";
  if (process.env.NODE_ENV === "production") return "production";
  return "development";
}

const env = resolveEnv();

export const config = {
  env,
  isDev: env === "development",
  isProd: env === "production",
  port: parseInt(process.env.ENGINE_PORT ?? "9721", 10),
  logVerbose: process.env.SHIP_LOG_VERBOSE === "true",
} as const;
