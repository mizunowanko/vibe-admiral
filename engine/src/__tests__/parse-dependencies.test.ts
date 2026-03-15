import { describe, expect, it } from "vitest";
import { parseDependencies } from "../github.js";

describe("parseDependencies", () => {
  it("returns empty array for empty body", () => {
    expect(parseDependencies("")).toEqual([]);
  });

  it("returns empty array for null/undefined body", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseDependencies(null as any)).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseDependencies(undefined as any)).toEqual([]);
  });

  it("returns empty array when no Dependencies section exists", () => {
    const body = "## Summary\nSome description\n## Notes\nSome notes";
    expect(parseDependencies(body)).toEqual([]);
  });

  it("extracts issue numbers from Dependencies section", () => {
    const body = [
      "## Summary",
      "Some description",
      "## Dependencies",
      "- Depends on #42",
      "- Depends on #99",
      "## Notes",
      "Some notes",
    ].join("\n");
    expect(parseDependencies(body)).toEqual([42, 99]);
  });

  it("deduplicates issue numbers", () => {
    const body = [
      "## Dependencies",
      "- Depends on #42",
      "- Also depends on #42",
      "- And #99",
    ].join("\n");
    expect(parseDependencies(body)).toEqual([42, 99]);
  });

  it("handles Dependencies as the last section (no trailing ##)", () => {
    const body = [
      "## Summary",
      "Some description",
      "## Dependencies",
      "- Depends on #10",
      "- Depends on #20",
    ].join("\n");
    expect(parseDependencies(body)).toEqual([10, 20]);
  });

  it("does NOT match ### Dependencies (h3 false positive)", () => {
    const body = [
      "## Summary",
      "Some description",
      "### Dependencies",
      "- Depends on #42",
      "## Notes",
      "Some notes",
    ].join("\n");
    expect(parseDependencies(body)).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    const body =
      "## Summary\r\nSome description\r\n## Dependencies\r\n- Depends on #42\r\n- Depends on #99\r\n## Notes\r\nSome notes";
    expect(parseDependencies(body)).toEqual([42, 99]);
  });

  it("handles CRLF with Dependencies as last section", () => {
    const body =
      "## Dependencies\r\n- Depends on #5\r\n- Depends on #10";
    expect(parseDependencies(body)).toEqual([5, 10]);
  });

  it("handles extra whitespace after heading", () => {
    const body = [
      "## Dependencies   ",
      "- Depends on #42",
    ].join("\n");
    expect(parseDependencies(body)).toEqual([42]);
  });

  it("ignores numbers without # prefix", () => {
    const body = [
      "## Dependencies",
      "- Depends on 42",
      "- Depends on #99",
    ].join("\n");
    expect(parseDependencies(body)).toEqual([99]);
  });
});
