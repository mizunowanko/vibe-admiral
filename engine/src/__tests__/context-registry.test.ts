import { describe, expect, it, beforeEach } from "vitest";
import { ContextRegistry } from "../context-registry.js";
import type { UnitContext } from "../context-registry.js";

function makeContext(overrides: Partial<UnitContext> = {}): UnitContext {
  return {
    fleetId: "fleet-1",
    unitKind: "ship",
    unitId: "unit-001",
    cwd: "/repo/.worktrees/feature/42-test",
    sessionId: null,
    customInstructionsSource: "fleet",
    customInstructionsHash: "abc123",
    ...overrides,
  };
}

describe("ContextRegistry", () => {
  let registry: ContextRegistry;

  beforeEach(() => {
    registry = new ContextRegistry();
  });

  describe("register / get", () => {
    it("registers and retrieves a context", () => {
      const ctx = makeContext();
      registry.register(ctx);
      expect(registry.get("unit-001")).toEqual(ctx);
    });

    it("returns null for unregistered unit", () => {
      expect(registry.get("nonexistent")).toBeNull();
    });
  });

  describe("assertBoundary", () => {
    it("passes when all fields match", () => {
      registry.register(makeContext());
      expect(() =>
        registry.assertBoundary("unit-001", { fleetId: "fleet-1", unitKind: "ship" }),
      ).not.toThrow();
    });

    it("throws on fleetId mismatch", () => {
      registry.register(makeContext());
      expect(() =>
        registry.assertBoundary("unit-001", { fleetId: "fleet-2" }),
      ).toThrow(/Boundary violation.*expected fleetId="fleet-2"/);
    });

    it("throws on cwd mismatch", () => {
      registry.register(makeContext());
      expect(() =>
        registry.assertBoundary("unit-001", { cwd: "/other/path" }),
      ).toThrow(/Boundary violation.*expected cwd/);
    });

    it("throws for unregistered unit", () => {
      expect(() =>
        registry.assertBoundary("nonexistent", { fleetId: "fleet-1" }),
      ).toThrow(/No context registered/);
    });
  });

  describe("swap", () => {
    it("returns the previous value and updates the field", () => {
      registry.register(makeContext({ sessionId: "old-session" }));
      const prev = registry.swap("unit-001", "sessionId", "new-session", "session refreshed");
      expect(prev).toBe("old-session");
      expect(registry.get("unit-001")?.sessionId).toBe("new-session");
    });

    it("throws for unregistered unit", () => {
      expect(() =>
        registry.swap("nonexistent", "sessionId", "x", "test"),
      ).toThrow(/No context registered/);
    });
  });

  describe("unregister", () => {
    it("removes a context", () => {
      registry.register(makeContext());
      registry.unregister("unit-001");
      expect(registry.get("unit-001")).toBeNull();
    });
  });

  describe("getByFleet", () => {
    it("returns only contexts for the given fleet", () => {
      registry.register(makeContext({ unitId: "unit-1", fleetId: "fleet-A" }));
      registry.register(makeContext({ unitId: "unit-2", fleetId: "fleet-A" }));
      registry.register(makeContext({ unitId: "unit-3", fleetId: "fleet-B" }));
      expect(registry.getByFleet("fleet-A")).toHaveLength(2);
    });
  });

  describe("hasConflictingCwd", () => {
    it("detects conflicting cwd in the same fleet", () => {
      registry.register(makeContext({ unitId: "unit-1", cwd: "/shared/path" }));
      expect(registry.hasConflictingCwd("fleet-1", "/shared/path", "unit-2")).toBe(true);
    });

    it("excludes the specified unit from the check", () => {
      registry.register(makeContext({ unitId: "unit-1", cwd: "/shared/path" }));
      expect(registry.hasConflictingCwd("fleet-1", "/shared/path", "unit-1")).toBe(false);
    });

    it("returns false when no conflict", () => {
      registry.register(makeContext({ unitId: "unit-1", cwd: "/other/path" }));
      expect(registry.hasConflictingCwd("fleet-1", "/unique/path")).toBe(false);
    });
  });
});
