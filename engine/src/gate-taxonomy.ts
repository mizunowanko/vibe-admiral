/**
 * Gate Taxonomy — Single Source of Truth for all Gate knowledge (#956)
 *
 * Every gate-related constant (prev/next phase, default type, skill name,
 * skip condition, replay events) is derived from a single GATE_TAXONOMY
 * record. Adding a new gate requires editing only this record.
 *
 * Import chain:
 *   phases.ts (base types) → gate-taxonomy.ts (gate knowledge) → consumers
 */
import {
  GATE_PHASES,
  PHASE_ORDER,
  isGatePhase,
  type Phase,
  type GatePhase,
  type GateType,
} from "./phases.js";
// === Gate Skip Context ===

export interface GateSkipContext {
  qaRequired: boolean;
}

// === Taxonomy Entry ===

export interface GateTaxonomyEntry {
  prevPhase: Phase;
  nextPhase: Phase;
  defaultGateType: GateType;
  escortSkill: string;
  skipCondition: (ctx: GateSkipContext) => string | null;
}

// === Single Source of Truth ===

export const GATE_TAXONOMY: Record<GatePhase, GateTaxonomyEntry> = {
  "plan-gate": {
    prevPhase: "plan",
    nextPhase: "coding",
    defaultGateType: "plan-review",
    escortSkill: "/escort-planning-gate",
    skipCondition: () => null,
  },
  "coding-gate": {
    prevPhase: "coding",
    nextPhase: "qa",
    defaultGateType: "code-review",
    escortSkill: "/escort-implementing-gate",
    skipCondition: () => null,
  },
  "qa-gate": {
    prevPhase: "qa",
    nextPhase: "merging",
    defaultGateType: "playwright",
    skipCondition: (ctx) => (!ctx.qaRequired ? "qaRequired: false" : null),
    escortSkill: "/escort-acceptance-test-gate",
  },
};

// === Derived Constants ===

const entries = Object.entries(GATE_TAXONOMY) as [GatePhase, GateTaxonomyEntry][];

export const DEFAULT_GATE_TYPES: Record<GatePhase, GateType> = Object.fromEntries(
  entries.map(([k, v]) => [k, v.defaultGateType]),
) as Record<GatePhase, GateType>;

export const GATE_NEXT_PHASE: Record<GatePhase, Phase> = Object.fromEntries(
  entries.map(([k, v]) => [k, v.nextPhase]),
) as Record<GatePhase, Phase>;

export const GATE_PREV_PHASE: Record<GatePhase, Phase> = Object.fromEntries(
  entries.map(([k, v]) => [k, v.prevPhase]),
) as Record<GatePhase, Phase>;

export const GATE_PHASE_SKILL: Record<GatePhase, string> = Object.fromEntries(
  entries.map(([k, v]) => [k, v.escortSkill]),
) as Record<GatePhase, string>;

export const GATE_SKIP_CONDITIONS: Record<GatePhase, (ctx: GateSkipContext) => string | null> =
  Object.fromEntries(
    entries.map(([k, v]) => [k, v.skipCondition]),
  ) as Record<GatePhase, (ctx: GateSkipContext) => string | null>;

// === PHASE_REPLAY_EVENTS — auto-generated from PHASE_ORDER + isGatePhase ===

export type GateReplayEvent = { type: "GATE_ENTER" } | { type: "GATE_APPROVED" };

function computePhaseReplayEvents(): Record<Phase, GateReplayEvent[]> {
  const result = {} as Record<Phase, GateReplayEvent[]>;
  const accumulated: GateReplayEvent[] = [];

  for (let i = 0; i < PHASE_ORDER.length; i++) {
    const phase = PHASE_ORDER[i]!;

    if (phase === "done") {
      result[phase] = [];
      continue;
    }

    result[phase] = [...accumulated];

    if (i < PHASE_ORDER.length - 1) {
      const nextPhase = PHASE_ORDER[i + 1]!;
      if (isGatePhase(nextPhase)) {
        accumulated.push({ type: "GATE_ENTER" });
      } else if (isGatePhase(phase)) {
        accumulated.push({ type: "GATE_APPROVED" });
      }
    }
  }

  result["paused"] = [];
  result["abandoned"] = [];

  return result;
}

export const PHASE_REPLAY_EVENTS: Record<Phase, GateReplayEvent[]> = computePhaseReplayEvents();

// === Compile-time completeness guard ===

{
  const taxonomyKeys = new Set(Object.keys(GATE_TAXONOMY));
  const gatePhaseSet = new Set<string>(GATE_PHASES);
  const missing = [...gatePhaseSet].filter((p) => !taxonomyKeys.has(p));
  const extra = [...taxonomyKeys].filter((k) => !gatePhaseSet.has(k));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `[gate-taxonomy] GATE_TAXONOMY/GATE_PHASES mismatch: ` +
        (missing.length > 0 ? `missing: ${missing.join(", ")}` : "") +
        (extra.length > 0 ? ` extra: ${extra.join(", ")}` : ""),
    );
  }
}
