import type {
  GatePhase,
  GateType,
  GateConfig,
  FleetGateSettings,
  Phase,
} from "./types.js";
import { DEFAULT_GATE_TYPES, GATE_NEXT_PHASE } from "./types.js";

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
