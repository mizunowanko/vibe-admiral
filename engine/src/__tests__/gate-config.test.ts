import { describe, expect, it } from "vitest";
import { GATE_TRANSITIONS, parseTransition, resolveGate } from "../gate-config.js";
import { DEFAULT_GATE_TYPES } from "../types.js";
import type { FleetGateSettings } from "../types.js";

describe("GATE_TRANSITIONS", () => {
  it("contains 3 transitions in order", () => {
    expect(GATE_TRANSITIONS).toEqual([
      "planning→implementing",
      "implementing→acceptance-test",
      "acceptance-test→merging",
    ]);
  });
});

describe("parseTransition", () => {
  it("splits planning→implementing", () => {
    expect(parseTransition("planning→implementing")).toEqual({
      from: "planning",
      to: "implementing",
    });
  });

  it("splits implementing→acceptance-test", () => {
    expect(parseTransition("implementing→acceptance-test")).toEqual({
      from: "implementing",
      to: "acceptance-test",
    });
  });

  it("splits acceptance-test→merging", () => {
    expect(parseTransition("acceptance-test→merging")).toEqual({
      from: "acceptance-test",
      to: "merging",
    });
  });
});

describe("resolveGate", () => {
  it("returns default gate type for each defined transition", () => {
    expect(resolveGate("planning", "implementing")).toBe("plan-review");
    expect(resolveGate("implementing", "acceptance-test")).toBe("code-review");
    expect(resolveGate("acceptance-test", "merging")).toBe(
      DEFAULT_GATE_TYPES["acceptance-test→merging"],
    );
  });

  it("returns null for non-gated transitions", () => {
    expect(resolveGate("planning", "acceptance-test")).toBeNull();
    expect(resolveGate("merging", "done")).toBeNull();
  });

  it("respects fleet settings: disabled gate", () => {
    const settings: FleetGateSettings = {
      "planning→implementing": false,
    };
    expect(resolveGate("planning", "implementing", settings)).toBeNull();
  });

  it("respects fleet settings: override gate type", () => {
    const settings: FleetGateSettings = {
      "implementing→acceptance-test": "playwright",
    };
    expect(resolveGate("implementing", "acceptance-test", settings)).toBe("playwright");
  });

  it("respects fleet settings: true uses default", () => {
    const settings: FleetGateSettings = {
      "implementing→acceptance-test": true,
    };
    expect(resolveGate("implementing", "acceptance-test", settings)).toBe("code-review");
  });

  it("uses default when transition not in settings", () => {
    const settings: FleetGateSettings = {
      "planning→implementing": false,
    };
    // Other transitions should still use defaults
    expect(resolveGate("implementing", "acceptance-test", settings)).toBe("code-review");
  });

  it("returns null for unknown status combinations", () => {
    // @ts-expect-error — testing invalid input
    expect(resolveGate("foo", "bar")).toBeNull();
  });
});
