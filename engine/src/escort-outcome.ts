/**
 * Escort Outcome — Discriminated union for all Escort exit paths (#956)
 *
 * Replaces the 6 implicit branches in onEscortExit() with an explicit
 * type. classifyEscortOutcome() is a pure function that determines the
 * outcome from observable state, making the logic testable without mocks.
 *
 * "died-pre-start" is not returned by classifyEscortOutcome() — it is
 * constructed directly by notifyLaunchFailure() for process-never-created cases.
 */
import type { Phase, GatePhase } from "./phases.js";
import type { GateIntent } from "./types.js";

export type EscortOutcome =
  | { kind: "verdict" }
  | { kind: "intent-approve" }
  | { kind: "died-post-start"; gatePhase: GatePhase; exitCode: number | null }
  | { kind: "fail-limit"; gatePhase: GatePhase; failCount: number; exitCode: number | null }
  | { kind: "died-pre-start"; gatePhase: GatePhase; reason: string };

export const MAX_ESCORT_FAILS = 3;

export interface EscortOutcomeContext {
  currentPhase: Phase;
  isGatePhase: boolean;
  exitCode: number | null;
  intent: GateIntent | null;
  escortFailCount: number;
}

/**
 * Classify the outcome of an Escort process exit.
 *
 * Called from onEscortExit() before any side effects. The classification
 * determines which handler path to take. Note: "intent-approve" may
 * degrade to "died-post-start" if the fallback commit fails.
 *
 * escortFailCount is the PRE-increment value (before ESCORT_DIED commit).
 * We predict the post-increment value: count + 1 >= MAX_ESCORT_FAILS.
 */
export function classifyEscortOutcome(ctx: EscortOutcomeContext): Exclude<EscortOutcome, { kind: "died-pre-start" }> {
  if (!ctx.isGatePhase) {
    return { kind: "verdict" };
  }

  const gatePhase = ctx.currentPhase as GatePhase;

  if (ctx.intent?.verdict === "approve") {
    return { kind: "intent-approve" };
  }

  if (ctx.escortFailCount + 1 >= MAX_ESCORT_FAILS) {
    return {
      kind: "fail-limit",
      gatePhase,
      failCount: ctx.escortFailCount + 1,
      exitCode: ctx.exitCode,
    };
  }

  return { kind: "died-post-start", gatePhase, exitCode: ctx.exitCode };
}
