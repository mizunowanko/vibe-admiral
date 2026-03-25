import { describe, expect, it } from "vitest";
import { GATE_PHASES, resolveGateType, getNextPhaseAfterGate } from "../gate-config.js";
import { DEFAULT_GATE_TYPES } from "../types.js";
import type { FleetGateSettings } from "../types.js";

describe("GATE_PHASES", () => {
  it("contains 3 gate phases in order", () => {
    expect(GATE_PHASES).toEqual([
      "plan-gate",
      "coding-gate",
      "qa-gate",
    ]);
  });
});

describe("resolveGateType", () => {
  it("returns default gate type for each gate phase", () => {
    expect(resolveGateType("plan-gate")).toBe("plan-review");
    expect(resolveGateType("coding-gate")).toBe("code-review");
    expect(resolveGateType("qa-gate")).toBe(
      DEFAULT_GATE_TYPES["qa-gate"],
    );
  });

  it("respects fleet settings: disabled gate", () => {
    const settings: FleetGateSettings = {
      "plan-gate": false,
    };
    expect(resolveGateType("plan-gate", settings)).toBeNull();
  });

  it("respects fleet settings: override gate type", () => {
    const settings: FleetGateSettings = {
      "coding-gate": "playwright",
    };
    expect(resolveGateType("coding-gate", settings)).toBe("playwright");
  });

  it("respects fleet settings: true uses default", () => {
    const settings: FleetGateSettings = {
      "coding-gate": true,
    };
    expect(resolveGateType("coding-gate", settings)).toBe("code-review");
  });

  it("uses default when gate phase not in settings", () => {
    const settings: FleetGateSettings = {
      "plan-gate": false,
    };
    // Other gate phases should still use defaults
    expect(resolveGateType("coding-gate", settings)).toBe("code-review");
  });
});

describe("getNextPhaseAfterGate", () => {
  it("returns coding after plan-gate", () => {
    expect(getNextPhaseAfterGate("plan-gate")).toBe("coding");
  });

  it("returns qa after coding-gate", () => {
    expect(getNextPhaseAfterGate("coding-gate")).toBe("qa");
  });

  it("returns merging after qa-gate", () => {
    expect(getNextPhaseAfterGate("qa-gate")).toBe("merging");
  });
});
