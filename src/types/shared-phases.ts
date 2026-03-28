/**
 * Phase definitions — Single Source of Truth for the Frontend.
 *
 * These definitions MUST stay in sync with engine/src/types.ts.
 * If the Engine adds or renames a phase, update this file accordingly.
 */

// === Phase (Ship lifecycle) ===
// Gate is a phase: plan → plan-gate → coding → coding-gate
// → qa → qa-gate → merging → done
// "error" is a derived state: phase ≠ done && process dead.
export type Phase =
  | "plan"
  | "plan-gate"
  | "coding"
  | "coding-gate"
  | "qa"
  | "qa-gate"
  | "merging"
  | "done"
  | "stopped";

/** Ordered list of active phases (excludes "stopped"). Used for progress display. */
export const PHASE_ORDER: readonly Phase[] = [
  "plan",
  "plan-gate",
  "coding",
  "coding-gate",
  "qa",
  "qa-gate",
  "merging",
] as const;

/** Gate phases where Escort review is required. */
export type GatePhase = "plan-gate" | "coding-gate" | "qa-gate";

/** Check if a phase is a gate phase. */
export function isGatePhase(phase: Phase): phase is GatePhase {
  return phase === "plan-gate" || phase === "coding-gate" || phase === "qa-gate";
}
