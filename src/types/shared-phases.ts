/**
 * Phase definitions — Frontend mirror of engine/src/phases.ts (#839)
 *
 * SSoT: engine/src/phases.ts
 * This file MUST stay in sync. The phases.test.ts (Engine) verifies
 * that PHASES and PHASE_ORDER match at test time.
 *
 * Gate is a phase: plan → plan-gate → coding → coding-gate
 * → qa → qa-gate → merging → done
 * "error" is a derived state: phase ≠ done && process dead.
 */

// === Phase Tuple (mirrors engine/src/phases.ts) ===

export const PHASES = [
  "plan",
  "plan-gate",
  "coding",
  "coding-gate",
  "qa",
  "qa-gate",
  "merging",
  "done",
  "paused",
  "abandoned",
] as const;

export type Phase = (typeof PHASES)[number];

/** Ordered list of active phases for forward-only progress display (excludes paused/abandoned). */
export const PHASE_ORDER: readonly Phase[] = [
  "plan",
  "plan-gate",
  "coding",
  "coding-gate",
  "qa",
  "qa-gate",
  "merging",
  "done",
] as const;

/** Gate phases tuple. */
export const GATE_PHASES = ["plan-gate", "coding-gate", "qa-gate"] as const;

/** Gate phases where Escort review is required. */
export type GatePhase = (typeof GATE_PHASES)[number];

/** Check if a phase is a gate phase. */
export function isGatePhase(phase: Phase): phase is GatePhase {
  return (GATE_PHASES as readonly string[]).includes(phase);
}
