import { describe, expect, it } from "vitest";
import { classifyEscortOutcome, MAX_ESCORT_FAILS, type EscortOutcomeContext } from "../escort-outcome.js";

function makeCtx(overrides: Partial<EscortOutcomeContext> = {}): EscortOutcomeContext {
  return {
    currentPhase: "plan-gate",
    isGatePhase: true,
    exitCode: 1,
    intent: null,
    escortFailCount: 0,
    ...overrides,
  };
}

describe("classifyEscortOutcome", () => {
  it("returns verdict when not in gate phase", () => {
    const result = classifyEscortOutcome(makeCtx({
      currentPhase: "coding",
      isGatePhase: false,
    }));
    expect(result.kind).toBe("verdict");
  });

  it("returns intent-approve when intent is approve", () => {
    const result = classifyEscortOutcome(makeCtx({
      intent: { verdict: "approve", declaredAt: new Date().toISOString() },
    }));
    expect(result.kind).toBe("intent-approve");
  });

  it("returns died-post-start for normal death in gate phase", () => {
    const result = classifyEscortOutcome(makeCtx({
      exitCode: 1,
      escortFailCount: 0,
    }));
    expect(result).toEqual({
      kind: "died-post-start",
      gatePhase: "plan-gate",
      exitCode: 1,
    });
  });

  it("returns fail-limit when escortFailCount will exceed MAX", () => {
    const result = classifyEscortOutcome(makeCtx({
      escortFailCount: MAX_ESCORT_FAILS - 1,
      exitCode: null,
    }));
    expect(result).toEqual({
      kind: "fail-limit",
      gatePhase: "plan-gate",
      failCount: MAX_ESCORT_FAILS,
      exitCode: null,
    });
  });

  it("returns died-post-start when escortFailCount is below limit", () => {
    const result = classifyEscortOutcome(makeCtx({
      escortFailCount: MAX_ESCORT_FAILS - 2,
    }));
    expect(result.kind).toBe("died-post-start");
  });

  it("intent-approve takes priority over fail-limit", () => {
    const result = classifyEscortOutcome(makeCtx({
      intent: { verdict: "approve", declaredAt: new Date().toISOString() },
      escortFailCount: MAX_ESCORT_FAILS - 1,
    }));
    expect(result.kind).toBe("intent-approve");
  });

  it("reject intent does not trigger intent-approve", () => {
    const result = classifyEscortOutcome(makeCtx({
      intent: { verdict: "reject", declaredAt: new Date().toISOString() },
    }));
    expect(result.kind).not.toBe("intent-approve");
  });

  it("works with all gate phases", () => {
    for (const gatePhase of ["plan-gate", "coding-gate", "qa-gate"] as const) {
      const result = classifyEscortOutcome(makeCtx({
        currentPhase: gatePhase,
        isGatePhase: true,
      }));
      expect(result.kind).toBe("died-post-start");
      if (result.kind === "died-post-start") {
        expect(result.gatePhase).toBe(gatePhase);
      }
    }
  });
});

describe("MAX_ESCORT_FAILS", () => {
  it("is 3", () => {
    expect(MAX_ESCORT_FAILS).toBe(3);
  });
});
