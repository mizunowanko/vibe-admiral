import { describe, expect, it } from "vitest";
import { GATE_PHASES, resolveGateType, getNextPhaseAfterGate } from "../gate-config.js";
import { DEFAULT_GATE_TYPES } from "../types.js";
import type { FleetGateSettings } from "../types.js";

describe("GATE_PHASES", () => {
  it("contains 3 gate phases in order", () => {
    expect(GATE_PHASES).toEqual([
      "planning-gate",
      "implementing-gate",
      "acceptance-test-gate",
    ]);
  });
});

describe("resolveGateType", () => {
  it("returns default gate type for each gate phase", () => {
    expect(resolveGateType("planning-gate")).toBe("plan-review");
    expect(resolveGateType("implementing-gate")).toBe("code-review");
    expect(resolveGateType("acceptance-test-gate")).toBe(
      DEFAULT_GATE_TYPES["acceptance-test-gate"],
    );
  });

  it("respects fleet settings: disabled gate", () => {
    const settings: FleetGateSettings = {
      "planning-gate": false,
    };
    expect(resolveGateType("planning-gate", settings)).toBeNull();
  });

  it("respects fleet settings: override gate type", () => {
    const settings: FleetGateSettings = {
      "implementing-gate": "playwright",
    };
    expect(resolveGateType("implementing-gate", settings)).toBe("playwright");
  });

  it("respects fleet settings: true uses default", () => {
    const settings: FleetGateSettings = {
      "implementing-gate": true,
    };
    expect(resolveGateType("implementing-gate", settings)).toBe("code-review");
  });

  it("uses default when gate phase not in settings", () => {
    const settings: FleetGateSettings = {
      "planning-gate": false,
    };
    // Other gate phases should still use defaults
    expect(resolveGateType("implementing-gate", settings)).toBe("code-review");
  });
});

describe("getNextPhaseAfterGate", () => {
  it("returns implementing after planning-gate", () => {
    expect(getNextPhaseAfterGate("planning-gate")).toBe("implementing");
  });

  it("returns acceptance-test after implementing-gate", () => {
    expect(getNextPhaseAfterGate("implementing-gate")).toBe("acceptance-test");
  });

  it("returns merging after acceptance-test-gate", () => {
    expect(getNextPhaseAfterGate("acceptance-test-gate")).toBe("merging");
  });
});
