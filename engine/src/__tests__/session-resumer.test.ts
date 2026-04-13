import { describe, expect, it } from "vitest";
import { validateOrFresh } from "../session-resumer.js";

describe("validateOrFresh", () => {
  it("returns fresh when no sessionId", () => {
    const result = validateOrFresh(null, { expectedCwd: "/repo" });
    expect(result.decision).toBe("fresh");
    expect(result.sessionId).toBeNull();
    expect(result.reason).toContain("no session ID");
  });

  it("returns resume when no persisted cwd (backward compat)", () => {
    const result = validateOrFresh("session-123", {
      expectedCwd: "/repo",
      persistedCwd: undefined,
    });
    expect(result.decision).toBe("resume");
    expect(result.sessionId).toBe("session-123");
    expect(result.reason).toContain("backward compat");
  });

  it("returns fresh when cwd changed", () => {
    const result = validateOrFresh("session-123", {
      expectedCwd: "/new/repo",
      persistedCwd: "/old/repo",
    });
    expect(result.decision).toBe("fresh");
    expect(result.sessionId).toBeNull();
    expect(result.reason).toContain("cwd changed");
  });

  it("returns resume when cwd matches", () => {
    const result = validateOrFresh("session-123", {
      expectedCwd: "/repo",
      persistedCwd: "/repo",
    });
    expect(result.decision).toBe("resume");
    expect(result.sessionId).toBe("session-123");
    expect(result.reason).toContain("cwd matches");
  });
});
