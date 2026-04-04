import type { MessageHandler } from "./handler-types";
import type { AdmiralSettings, CaffeinateStatus } from "@/types";

let rateLimitTimer = 0;

export const handleAdmiralSettingsData: MessageHandler<"admiral-settings:data"> = (msg, ctx) => {
  ctx.admiralSettingsStore.setSettings(msg.data as AdmiralSettings);
};

export const handleCaffeinateStatus: MessageHandler<"caffeinate:status"> = (msg, ctx) => {
  ctx.uiStore.setCaffeinateActive((msg.data as CaffeinateStatus).active);
};

export const handleRateLimitDetected: MessageHandler<"rate-limit:detected"> = (_msg, ctx) => {
  ctx.uiStore.setRateLimitActive(true);
  clearTimeout(rateLimitTimer);
  rateLimitTimer = window.setTimeout(() => ctx.uiStore.setRateLimitActive(false), 30_000);
};

export const handleEngineRestarting: MessageHandler<"engine:restarting"> = (_msg, ctx) => {
  ctx.uiStore.setEngineRestarting(true);
};

export const handleEngineRestarted: MessageHandler<"engine:restarted"> = (_msg, ctx) => {
  ctx.uiStore.setEngineRestarting(false);
};

export const handleEnginePreviousCrash: MessageHandler<"engine:previous-crash"> = (msg, ctx) => {
  console.warn("[engine] Previous crash detected:", msg.data);
  ctx.uiStore.setPreviousCrash(msg.data);
};

export const handleError: MessageHandler<"error"> = (msg) => {
  console.error(`Engine error [${msg.data.source}]:`, msg.data.message);
};

/** Ping is handled at ws-client layer; should not reach here. */
export const handlePing: MessageHandler<"ping"> = () => {};
