import type {
  GateTransition,
  GateType,
  GateConfig,
  FleetGateSettings,
  ShipStatus,
} from "./types.js";
import { DEFAULT_GATE_TYPES } from "./types.js";

/**
 * All defined gate transitions. Order matters for display.
 */
export const GATE_TRANSITIONS: readonly GateTransition[] = [
  "planning→implementing",
  "testing→reviewing",
  "reviewing→acceptance-test",
  "acceptance-test→merging",
] as const;

/**
 * Parse a gate transition key into its from/to statuses.
 */
export function parseTransition(
  transition: GateTransition,
): { from: ShipStatus; to: ShipStatus } {
  const [from, to] = transition.split("→") as [string, string];
  return { from: from as ShipStatus, to: to as ShipStatus };
}

/**
 * Check if a status transition has a gate, and return the gate type if so.
 * Returns null if no gate is configured for this transition.
 */
export function resolveGate(
  from: ShipStatus,
  to: ShipStatus,
  settings?: FleetGateSettings,
): GateType | null {
  const key = `${from}→${to}` as GateTransition;
  if (!GATE_TRANSITIONS.includes(key)) return null;

  const config: GateConfig = settings?.[key] ?? true;
  if (config === false) return null;
  if (config === true) return DEFAULT_GATE_TYPES[key];
  return config;
}
