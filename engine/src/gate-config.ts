import type {
  GatePhase,
  GateType,
  GateConfig,
  FleetGateSettings,
  Phase,
} from "./types.js";
import { DEFAULT_GATE_TYPES, GATE_NEXT_PHASE } from "./types.js";

// === Gate Skip Conditions ===

/** Context passed to gate skip condition functions. */
export interface GateSkipContext {
  qaRequired: boolean;
}

/** Result of shouldSkipGate: null if gate should run, otherwise the skip reason. */
export type GateSkipResult = { skip: true; reason: string } | { skip: false };

/**
 * Per-gate-phase skip condition table.
 * Each function returns a skip reason string if the gate should be skipped, or null if it should run.
 * Gate disable (config=false) and auto-approve are handled separately in shouldSkipGate().
 */
const GATE_SKIP_CONDITIONS: Record<GatePhase, (ctx: GateSkipContext) => string | null> = {
  "plan-gate": () => null,
  "coding-gate": () => null,
  "qa-gate": (ctx) => (!ctx.qaRequired ? "qaRequired: false" : null),
};

/**
 * Determine whether a gate should be skipped.
 * Checks in order: gate disabled → auto-approve → per-gate skip conditions.
 */
export function shouldSkipGate(
  gatePhase: GatePhase,
  gateSettings: FleetGateSettings | undefined,
  ctx: GateSkipContext,
): GateSkipResult {
  const gateType = resolveGateType(gatePhase, gateSettings);

  if (gateType === null) {
    return { skip: true, reason: "gate disabled" };
  }
  if (gateType === "auto-approve") {
    return { skip: true, reason: "auto-approve" };
  }

  const conditionReason = GATE_SKIP_CONDITIONS[gatePhase](ctx);
  if (conditionReason !== null) {
    return { skip: true, reason: conditionReason };
  }

  return { skip: false };
}

/**
 * All defined gate phases. Order matters for display.
 */
export const GATE_PHASES: readonly GatePhase[] = [
  "plan-gate",
  "coding-gate",
  "qa-gate",
] as const;

/**
 * Resolve the gate type for a gate phase.
 * Returns null if the gate is disabled for this phase.
 */
export function resolveGateType(
  gatePhase: GatePhase,
  settings?: FleetGateSettings,
): GateType | null {
  const config: GateConfig = settings?.[gatePhase] ?? true;
  if (config === false) return null;
  if (config === true) return DEFAULT_GATE_TYPES[gatePhase];
  return config;
}

/**
 * Get the next phase after a gate is approved.
 */
export function getNextPhaseAfterGate(gatePhase: GatePhase): Phase {
  return GATE_NEXT_PHASE[gatePhase];
}
