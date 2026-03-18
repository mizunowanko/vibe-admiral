import { describe, expect, it, vi, beforeEach } from "vitest";
import { sortIssuesByPriority, isBlocked } from "../issue-tracker.js";
import type { Issue } from "../types.js";

vi.mock("../github.js", () => ({
  listSubIssues: vi.fn(),
  getOpenDependsOnDeps: vi.fn(),
  getOpenBodyDependencies: vi.fn(),
  getIssue: vi.fn(),
}));

import * as github from "../github.js";

const mockListSubIssues = vi.mocked(github.listSubIssues);
const mockGetOpenDependsOnDeps = vi.mocked(github.getOpenDependsOnDeps);
const mockGetOpenBodyDependencies = vi.mocked(github.getOpenBodyDependencies);

const REPO = "owner/repo";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    title: "Test",
    body: "",
    labels: [],
    state: "open",
    ...overrides,
  };
}

describe("sortIssuesByPriority", () => {
  it("sorts priority/critical first", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["type/feature"] }),
      makeIssue({ number: 2, labels: ["priority/critical", "type/feature"] }),
    ];
    const sorted = sortIssuesByPriority(issues);
    expect(sorted.map((i) => i.number)).toEqual([2, 1]);
  });

  it("sorts by type priority within same critical tier", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["type/feature"] }),
      makeIssue({ number: 2, labels: ["type/bug"] }),
      makeIssue({ number: 3, labels: ["type/skill"] }),
    ];
    const sorted = sortIssuesByPriority(issues);
    expect(sorted.map((i) => i.number)).toEqual([3, 2, 1]);
  });

  it("sorts issues with fewer depends-on labels first within same tier", () => {
    const issues = [
      makeIssue({
        number: 1,
        labels: ["type/feature", "depends-on/10", "depends-on/20"],
      }),
      makeIssue({ number: 2, labels: ["type/feature"] }),
      makeIssue({ number: 3, labels: ["type/feature", "depends-on/10"] }),
    ];
    const sorted = sortIssuesByPriority(issues);
    expect(sorted.map((i) => i.number)).toEqual([2, 3, 1]);
  });

  it("issues without recognized type labels come last", () => {
    const issues = [
      makeIssue({ number: 1, labels: [] }),
      makeIssue({ number: 2, labels: ["type/feature"] }),
    ];
    const sorted = sortIssuesByPriority(issues);
    expect(sorted.map((i) => i.number)).toEqual([2, 1]);
  });

  it("preserves order for equal priority and dependency count", () => {
    const issues = [
      makeIssue({ number: 1, labels: ["type/feature"] }),
      makeIssue({ number: 2, labels: ["type/feature"] }),
    ];
    const sorted = sortIssuesByPriority(issues);
    expect(sorted.map((i) => i.number)).toEqual([1, 2]);
  });
});

describe("isBlocked", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when sub-issues are open", async () => {
    mockListSubIssues.mockResolvedValue([
      makeIssue({ number: 10, state: "open" }),
    ]);
    mockGetOpenDependsOnDeps.mockResolvedValue([]);
    mockGetOpenBodyDependencies.mockResolvedValue([]);

    expect(await isBlocked(REPO, 1, "", [])).toBe(true);
  });

  it("returns true when depends-on labels point to open issues", async () => {
    mockListSubIssues.mockResolvedValue([]);
    mockGetOpenDependsOnDeps.mockResolvedValue([42]);
    mockGetOpenBodyDependencies.mockResolvedValue([]);

    expect(await isBlocked(REPO, 1, "", ["depends-on/42"])).toBe(true);
  });

  it("returns true when body dependencies are open (legacy)", async () => {
    mockListSubIssues.mockResolvedValue([]);
    mockGetOpenDependsOnDeps.mockResolvedValue([]);
    mockGetOpenBodyDependencies.mockResolvedValue([99]);

    expect(await isBlocked(REPO, 1, "## Dependencies\n- Depends on #99", [])).toBe(true);
  });

  it("returns false when all dependencies are resolved", async () => {
    mockListSubIssues.mockResolvedValue([
      makeIssue({ number: 10, state: "closed" }),
    ]);
    mockGetOpenDependsOnDeps.mockResolvedValue([]);
    mockGetOpenBodyDependencies.mockResolvedValue([]);

    expect(await isBlocked(REPO, 1, "", ["depends-on/10"])).toBe(false);
  });

  it("skips depends-on check when labels not provided", async () => {
    mockListSubIssues.mockResolvedValue([]);
    mockGetOpenBodyDependencies.mockResolvedValue([]);

    expect(await isBlocked(REPO, 1, "")).toBe(false);
    expect(mockGetOpenDependsOnDeps).not.toHaveBeenCalled();
  });
});
