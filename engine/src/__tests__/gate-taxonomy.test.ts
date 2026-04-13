import { describe, expect, it } from "vitest";
import {
  GATE_TAXONOMY,
  DEFAULT_GATE_TYPES,
  GATE_NEXT_PHASE,
  GATE_PREV_PHASE,
  GATE_PHASE_SKILL,
  GATE_SKIP_CONDITIONS,
  PHASE_REPLAY_EVENTS,
} from "../gate-taxonomy.js";
import { GATE_PHASES, PHASES, PHASE_ORDER, isGatePhase, type Phase } from "../phases.js";

describe("GATE_TAXONOMY completeness", () => {
  it("covers all GATE_PHASES", () => {
    const taxonomyKeys = Object.keys(GATE_TAXONOMY).sort();
    const gatePhases = [...GATE_PHASES].sort();
    expect(taxonomyKeys).toEqual(gatePhases);
  });

  it("prevPhase + nextPhase are valid PHASES entries", () => {
    for (const [, entry] of Object.entries(GATE_TAXONOMY)) {
      expect(PHASES).toContain(entry.prevPhase);
      expect(PHASES).toContain(entry.nextPhase);
    }
  });

  it("prevPhase is never a gate phase", () => {
    for (const [, entry] of Object.entries(GATE_TAXONOMY)) {
      expect(isGatePhase(entry.prevPhase)).toBe(false);
    }
  });

  it("nextPhase is never a gate phase", () => {
    for (const [, entry] of Object.entries(GATE_TAXONOMY)) {
      expect(isGatePhase(entry.nextPhase)).toBe(false);
    }
  });
});

describe("Derived constants match GATE_TAXONOMY", () => {
  it("DEFAULT_GATE_TYPES", () => {
    for (const gatePhase of GATE_PHASES) {
      expect(DEFAULT_GATE_TYPES[gatePhase]).toBe(GATE_TAXONOMY[gatePhase].defaultGateType);
    }
  });

  it("GATE_NEXT_PHASE", () => {
    for (const gatePhase of GATE_PHASES) {
      expect(GATE_NEXT_PHASE[gatePhase]).toBe(GATE_TAXONOMY[gatePhase].nextPhase);
    }
  });

  it("GATE_PREV_PHASE", () => {
    for (const gatePhase of GATE_PHASES) {
      expect(GATE_PREV_PHASE[gatePhase]).toBe(GATE_TAXONOMY[gatePhase].prevPhase);
    }
  });

  it("GATE_PHASE_SKILL", () => {
    for (const gatePhase of GATE_PHASES) {
      expect(GATE_PHASE_SKILL[gatePhase]).toBe(GATE_TAXONOMY[gatePhase].escortSkill);
    }
  });

  it("GATE_SKIP_CONDITIONS", () => {
    for (const gatePhase of GATE_PHASES) {
      expect(GATE_SKIP_CONDITIONS[gatePhase]).toBe(GATE_TAXONOMY[gatePhase].skipCondition);
    }
  });
});

describe("PHASE_REPLAY_EVENTS auto-generation", () => {
  it("plan starts with empty events", () => {
    expect(PHASE_REPLAY_EVENTS["plan"]).toEqual([]);
  });

  it("plan-gate has [GATE_ENTER]", () => {
    expect(PHASE_REPLAY_EVENTS["plan-gate"]).toEqual([{ type: "GATE_ENTER" }]);
  });

  it("coding has [GATE_ENTER, GATE_APPROVED]", () => {
    expect(PHASE_REPLAY_EVENTS["coding"]).toEqual([
      { type: "GATE_ENTER" },
      { type: "GATE_APPROVED" },
    ]);
  });

  it("merging has 3 × [GATE_ENTER, GATE_APPROVED]", () => {
    expect(PHASE_REPLAY_EVENTS["merging"]).toEqual([
      { type: "GATE_ENTER" },
      { type: "GATE_APPROVED" },
      { type: "GATE_ENTER" },
      { type: "GATE_APPROVED" },
      { type: "GATE_ENTER" },
      { type: "GATE_APPROVED" },
    ]);
  });

  it("done/paused/abandoned have empty events", () => {
    expect(PHASE_REPLAY_EVENTS["done"]).toEqual([]);
    expect(PHASE_REPLAY_EVENTS["paused"]).toEqual([]);
    expect(PHASE_REPLAY_EVENTS["abandoned"]).toEqual([]);
  });

  it("covers all PHASES", () => {
    for (const phase of PHASES) {
      expect(PHASE_REPLAY_EVENTS).toHaveProperty(phase);
    }
  });

  it("events accumulate monotonically along PHASE_ORDER", () => {
    let prevLength = 0;
    for (const phase of PHASE_ORDER) {
      if (phase === "done") continue;
      const events = PHASE_REPLAY_EVENTS[phase as Phase];
      expect(events.length).toBeGreaterThanOrEqual(prevLength);
      prevLength = events.length;
    }
  });
});
