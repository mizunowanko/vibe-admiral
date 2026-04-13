import type {
  GatePhase,
  GateType,
  GateConfig,
  FleetGateSettings,
  Phase,
} from "./types.js";
import { DEFAULT_GATE_TYPES, GATE_NEXT_PHASE } from "./types.js";
import { GATE_SKIP_CONDITIONS, type GateSkipContext } from "./gate-taxonomy.js";

// GateSkipContext and GATE_SKIP_CONDITIONS moved to gate-taxonomy.ts (#956).
// Re-export for backwards compatibility.
export type { GateSkipContext } from "./gate-taxonomy.js";

/** Result of shouldSkipGate: null if gate should run, otherwise the skip reason. */
export type GateSkipResult = { skip: true; reason: string } | { skip: false };

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
