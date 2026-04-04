/**
 * Phase Definitions — Single Source of Truth (#839)
 *
 * All phase names, ordering, and gate mappings are defined here.
 * The Phase type is derived from the PHASES tuple, eliminating
 * hand-maintained string union types.
 *
 * Import chain:
 *   phases.ts (SSoT) → types.ts (re-export) → all Engine consumers
 *   phases.ts (SSoT) → ship-machine.ts (states must match PHASES)
 *
 * Frontend has its own copy at src/types/shared-phases.ts that MUST
 * stay in sync. The phases.test.ts verifies consistency at test time.
 */

// === Phase Tuple (Single Source of Truth) ===

/**
 * All valid phases in lifecycle order.
 * Adding/removing/renaming a phase here automatically updates the Phase type
 * and all derived constants.
 */
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

/** Phase type — automatically derived from the PHASES tuple. */
export type Phase = (typeof PHASES)[number];

// === Phase Ordering ===

/** Ordered list of all phases for forward-only validation (excludes paused/abandoned). */
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

// === Gate Phases ===

/** Gate phases tuple — derived from PHASES for type safety. */
export const GATE_PHASES = ["plan-gate", "coding-gate", "qa-gate"] as const;

/** Gate phases where Escort review is required. */
export type GatePhase = (typeof GATE_PHASES)[number];

/** Gate type determines which Dispatch sub-agent or mechanism handles the check. */
export type GateType = "plan-review" | "code-review" | "playwright" | "auto-approve";

/** Per-gate configuration: true = default type, string = specific type, false = disabled. */
export type GateConfig = boolean | GateType;

/** Fleet-level gate settings. Omitted gate phases use defaults. */
export type FleetGateSettings = Partial<Record<GatePhase, GateConfig>>;

/** Default gate types for each gate phase. */
export const DEFAULT_GATE_TYPES: Record<GatePhase, GateType> = {
  "plan-gate": "plan-review",
  "coding-gate": "code-review",
  "qa-gate": "playwright",
};

/** The phase that follows each gate phase when approved. */
export const GATE_NEXT_PHASE: Record<GatePhase, Phase> = {
  "plan-gate": "coding",
  "coding-gate": "qa",
  "qa-gate": "merging",
};

/** The phase preceding each gate phase (what triggers the gate). */
export const GATE_PREV_PHASE: Record<GatePhase, Phase> = {
  "plan-gate": "plan",
  "coding-gate": "coding",
  "qa-gate": "qa",
};

/** Check if a phase is a gate phase. */
export function isGatePhase(phase: Phase): phase is GatePhase {
  return (GATE_PHASES as readonly string[]).includes(phase);
}

