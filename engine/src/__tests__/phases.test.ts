import { describe, expect, it } from "vitest";
import { PHASES, PHASE_ORDER, GATE_PHASES, isGatePhase } from "../phases.js";
import { shipMachine } from "../ship-machine.js";

describe("Phase SSoT consistency (#839)", () => {
  it("PHASES tuple matches XState machine state keys", () => {
    const machineStates = Object.keys(
      shipMachine.config.states ?? {},
    ).sort();
    const phasesSorted = [...PHASES].sort();
    expect(phasesSorted).toEqual(machineStates);
  });

  it("PHASE_ORDER is a subset of PHASES (no stale entries)", () => {
    for (const phase of PHASE_ORDER) {
      expect(PHASES).toContain(phase);
    }
  });

  it("PHASE_ORDER excludes paused and abandoned", () => {
    expect(PHASE_ORDER).not.toContain("paused");
    expect(PHASE_ORDER).not.toContain("abandoned");
  });

  it("GATE_PHASES are all valid phases", () => {
    for (const gatePhase of GATE_PHASES) {
      expect(PHASES).toContain(gatePhase);
    }
  });

  it("isGatePhase correctly identifies gate phases", () => {
    for (const phase of PHASES) {
      const expected = GATE_PHASES.includes(phase as typeof GATE_PHASES[number]);
      expect(isGatePhase(phase)).toBe(expected);
    }
  });

  it("Frontend shared-phases.ts stays in sync", async () => {
    // Dynamic import to load the frontend version
    const frontend = await import("../../../src/types/shared-phases.js");
    expect([...frontend.PHASES]).toEqual([...PHASES]);
    expect([...frontend.PHASE_ORDER]).toEqual([...PHASE_ORDER]);
    expect([...frontend.GATE_PHASES]).toEqual([...GATE_PHASES]);
  });
});
