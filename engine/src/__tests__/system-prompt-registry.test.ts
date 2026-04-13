import { describe, expect, it } from "vitest";
import { compose, composeForGate } from "../system-prompt-registry.js";
import type { CustomInstructions } from "../types.js";

const CI: CustomInstructions = {
  shared: "共有指示",
  dock: "Dock指示",
  flagship: "Flagship指示",
  ship: "Ship指示",
  escort: "Escort指示",
};

describe("compose", () => {
  it("returns undefined text when no customInstructions", () => {
    const result = compose({ unitKind: "ship" });
    expect(result.text).toBeUndefined();
    expect(result.sourceAudit).toHaveLength(0);
  });

  describe("commander", () => {
    it("composes shared + dock with wrapper", () => {
      const result = compose({ unitKind: "commander", customInstructions: CI, role: "dock" });
      expect(result.text).toContain("## Custom Instructions");
      expect(result.text).toContain("共有指示");
      expect(result.text).toContain("Dock指示");
      expect(result.text).not.toContain("Ship指示");
    });

    it("composes shared + flagship with wrapper", () => {
      const result = compose({ unitKind: "commander", customInstructions: CI, role: "flagship" });
      expect(result.text).toContain("## Custom Instructions");
      expect(result.text).toContain("Flagship指示");
    });
  });

  describe("ship", () => {
    it("composes shared + ship WITHOUT wrapper", () => {
      const result = compose({ unitKind: "ship", customInstructions: CI });
      expect(result.text).not.toContain("## Custom Instructions");
      expect(result.text).toContain("共有指示");
      expect(result.text).toContain("Ship指示");
    });
  });

  describe("escort", () => {
    it("composes shared + escort WITH wrapper", () => {
      const result = compose({ unitKind: "escort", customInstructions: CI });
      expect(result.text).toContain("## Custom Instructions");
      expect(result.text).toContain("共有指示");
      expect(result.text).toContain("Escort指示");
    });
  });

  describe("dispatch", () => {
    it("only uses shared", () => {
      const result = compose({ unitKind: "dispatch", customInstructions: CI });
      expect(result.text).not.toContain("## Custom Instructions");
      expect(result.text).toContain("共有指示");
    });
  });

  it("records sourceAudit with hashes", () => {
    const result = compose({ unitKind: "ship", customInstructions: CI });
    expect(result.sourceAudit.length).toBeGreaterThanOrEqual(2);
    const composed = result.sourceAudit.find((s) => s.field === "composed");
    expect(composed).toBeDefined();
    expect(composed?.hash).toBeTruthy();
  });

  it("handles partial customInstructions (shared only)", () => {
    const result = compose({ unitKind: "ship", customInstructions: { shared: "only shared" } });
    expect(result.text).toBe("only shared");
  });
});

describe("composeForGate", () => {
  it("returns both escort and ship texts", () => {
    const result = composeForGate(CI);
    expect(result.escortText).toContain("Escort指示");
    expect(result.escortText).toContain("## Custom Instructions");
    expect(result.shipText).toContain("Ship指示");
    expect(result.shipText).not.toContain("## Custom Instructions");
  });

  it("returns undefined texts when no CI", () => {
    const result = composeForGate(undefined);
    expect(result.escortText).toBeUndefined();
    expect(result.shipText).toBeUndefined();
  });

  it("collects sourceAudit from both", () => {
    const result = composeForGate(CI);
    expect(result.sourceAudit.length).toBeGreaterThan(0);
  });
});
