import { describe, it, expect } from "vitest";
import { phaseDisplayName, gateTypeDisplayName } from "./ship-status";

describe("phaseDisplayName", () => {
  it("capitalizes simple phases", () => {
    expect(phaseDisplayName("plan")).toBe("Plan");
    expect(phaseDisplayName("coding")).toBe("Coding");
    expect(phaseDisplayName("merging")).toBe("Merging");
    expect(phaseDisplayName("done")).toBe("Done");
    expect(phaseDisplayName("stopped")).toBe("Stopped");
  });

  it("handles QA specially", () => {
    expect(phaseDisplayName("qa")).toBe("QA");
  });

  it("converts gate phases to '(Review)' suffix", () => {
    expect(phaseDisplayName("plan-gate")).toBe("Plan (Review)");
    expect(phaseDisplayName("coding-gate")).toBe("Coding (Review)");
    expect(phaseDisplayName("qa-gate")).toBe("QA (Review)");
  });
});

describe("gateTypeDisplayName", () => {
  it("returns Japanese labels for known gate types", () => {
    expect(gateTypeDisplayName("plan-review")).toBe("計画レビュー");
    expect(gateTypeDisplayName("code-review")).toBe("コードレビュー");
    expect(gateTypeDisplayName("playwright")).toBe("QA テスト");
    expect(gateTypeDisplayName("auto-approve")).toBe("自動承認");
  });

  it("returns raw value for unknown gate types", () => {
    expect(gateTypeDisplayName("custom-type")).toBe("custom-type");
  });

  it("returns 'Gate' when no gate type provided", () => {
    expect(gateTypeDisplayName()).toBe("Gate");
    expect(gateTypeDisplayName(undefined)).toBe("Gate");
  });
});
