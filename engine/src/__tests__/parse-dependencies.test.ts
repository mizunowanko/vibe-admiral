import { describe, expect, it } from "vitest";
import { parseDependencies } from "../github.js";

describe("parseDependencies", () => {
  it("returns empty array for empty body", () => {
    expect(parseDependencies("")).toEqual([]);
  });

  it("returns empty array for null-ish body", () => {
    expect(parseDependencies(null as unknown as string)).toEqual([]);
    expect(parseDependencies(undefined as unknown as string)).toEqual([]);
  });

  it("returns empty array when no Dependencies section exists", () => {
    const body = "## Context\nSome text\n## Changes\nMore text";
    expect(parseDependencies(body)).toEqual([]);
  });

  it("extracts issue numbers from Dependencies section", () => {
    const body = [
      "## Context",
      "Some context",
      "## Dependencies",
      "- Depends on #42",
      "- Related to #123",
      "## Other Section",
    ].join("\n");
    expect(parseDependencies(body)).toEqual([42, 123]);
  });

  it("deduplicates issue numbers", () => {
    const body = [
      "## Dependencies",
      "- Depends on #42",
      "- Also depends on #42",
      "- And #42 again",
    ].join("\n");
    expect(parseDependencies(body)).toEqual([42]);
  });

  it("handles Dependencies as the last section (no trailing ##)", () => {
    const body = [
      "## Context",
      "Some context",
      "## Dependencies",
      "- Depends on #10",
      "- Related to #20",
    ].join("\n");
    expect(parseDependencies(body)).toEqual([10, 20]);
  });

  it("does NOT match ### Dependencies (h3 false positive)", () => {
    const body = [
      "## Context",
      "Some context",
      "### Dependencies",
      "- #42",
      "- #99",
      "## Other",
    ].join("\n");
    expect(parseDependencies(body)).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    const body =
      "## Context\r\nSome context\r\n## Dependencies\r\n- #42\r\n- #99\r\n## Other\r\n";
    expect(parseDependencies(body)).toEqual([42, 99]);
  });

  it("handles Dependencies section with extra whitespace after header", () => {
    const body = "## Dependencies   \n- #5\n- #10\n";
    expect(parseDependencies(body)).toEqual([5, 10]);
  });

  it("extracts numbers from various reference formats", () => {
    const body = [
      "## Dependencies",
      "- Depends on #1",
      "- Blocked by #2 and #3",
      "- See issue #4",
    ].join("\n");
    expect(parseDependencies(body)).toEqual([1, 2, 3, 4]);
  });

  it("ignores numbers without # prefix", () => {
    const body = ["## Dependencies", "- Issue 42 is related", "- See #7"].join(
      "\n",
    );
    expect(parseDependencies(body)).toEqual([7]);
  });
});
