import { describe, expect, it } from "vitest";
import { GATE_PHASES, resolveGateType, getNextPhaseAfterGate, shouldSkipGate } from "../gate-config.js";
import type { GateSkipContext } from "../gate-config.js";
import { DEFAULT_GATE_TYPES } from "../types.js";
import type { FleetGateSettings, GatePhase } from "../types.js";

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

describe("shouldSkipGate", () => {
  const defaultCtx: GateSkipContext = { qaRequired: true };
  const qaFalseCtx: GateSkipContext = { qaRequired: false };

  describe("gate disabled (config=false)", () => {
    it.each<GatePhase>(["plan-gate", "coding-gate", "qa-gate"])(
      "skips %s when disabled",
      (gatePhase) => {
        const settings: FleetGateSettings = { [gatePhase]: false };
        const result = shouldSkipGate(gatePhase, settings, defaultCtx);
        expect(result).toEqual({ skip: true, reason: "gate disabled" });
      },
    );
  });

  describe("auto-approve gate type", () => {
    it.each<GatePhase>(["plan-gate", "coding-gate", "qa-gate"])(
      "skips %s when auto-approve",
      (gatePhase) => {
        const settings: FleetGateSettings = { [gatePhase]: "auto-approve" };
        const result = shouldSkipGate(gatePhase, settings, defaultCtx);
        expect(result).toEqual({ skip: true, reason: "auto-approve" });
      },
    );
  });

  describe("qaRequired: false only affects qa-gate (#835)", () => {
    it("does not skip plan-gate when qaRequired=false", () => {
      const result = shouldSkipGate("plan-gate", undefined, qaFalseCtx);
      expect(result).toEqual({ skip: false });
    });

    it("does not skip coding-gate when qaRequired=false", () => {
      const result = shouldSkipGate("coding-gate", undefined, qaFalseCtx);
      expect(result).toEqual({ skip: false });
    });

    it("skips qa-gate when qaRequired=false", () => {
      const result = shouldSkipGate("qa-gate", undefined, qaFalseCtx);
      expect(result).toEqual({ skip: true, reason: "qaRequired: false" });
    });

    it("does not skip qa-gate when qaRequired=true", () => {
      const result = shouldSkipGate("qa-gate", undefined, defaultCtx);
      expect(result).toEqual({ skip: false });
    });
  });

  describe("default settings (no overrides)", () => {
    it.each<GatePhase>(["plan-gate", "coding-gate", "qa-gate"])(
      "does not skip %s with default settings and qaRequired=true",
      (gatePhase) => {
        const result = shouldSkipGate(gatePhase, undefined, defaultCtx);
        expect(result).toEqual({ skip: false });
      },
    );
  });
});
