import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock child_process before importing the module under test
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
  mkdir: vi.fn(),
  symlink: vi.fn(),
}));

import { execFile } from "node:child_process";
import { access, mkdir, symlink } from "node:fs/promises";
import {
  getRepoRoot,
  list,
  listFeatureWorktrees,
  toKebabCase,
} from "../worktree.js";

// Helper to make execFile call its callback with the given stdout
function mockExecFileResult(stdout: string) {
  vi.mocked(execFile).mockImplementation(
    (_cmd: string, _args: unknown, _opts: unknown, ...rest: unknown[]) => {
      // execFile can be called with 2, 3, or 4 args; callback is the last
      const callback =
        typeof _opts === "function"
          ? (_opts as (err: Error | null, result: { stdout: string }) => void)
          : (rest[0] as (err: Error | null, result: { stdout: string }) => void);
      callback(null, { stdout });
      return undefined as unknown as ReturnType<typeof execFile>;
    },
  );
}

describe("worktree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access).mockRejectedValue(new Error("ENOENT"));
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(symlink).mockResolvedValue(undefined);
  });

  describe("getRepoRoot", () => {
    it("returns trimmed git output", async () => {
      mockExecFileResult("/home/user/repo\n");
      const result = await getRepoRoot("/home/user/repo/subdir");
      expect(result).toBe("/home/user/repo");
    });
  });

  describe("list", () => {
    it("parses porcelain output into Worktree objects", async () => {
      const porcelain = [
        "worktree /home/user/repo",
        "HEAD abc123",
        "branch refs/heads/main",
        "",
        "worktree /home/user/repo/.worktrees/feature/42-test",
        "HEAD def456",
        "branch refs/heads/feature/42-test",
        "",
      ].join("\n");

      mockExecFileResult(porcelain);
      const result = await list("/home/user/repo");

      expect(result).toEqual([
        { path: "/home/user/repo", head: "abc123", branch: "main" },
        {
          path: "/home/user/repo/.worktrees/feature/42-test",
          head: "def456",
          branch: "feature/42-test",
        },
      ]);
    });

    it("returns empty array for empty output", async () => {
      mockExecFileResult("");
      const result = await list("/home/user/repo");
      expect(result).toEqual([]);
    });

    it("handles bare worktree (no branch)", async () => {
      const porcelain = [
        "worktree /home/user/repo",
        "HEAD abc123",
        "branch refs/heads/main",
        "",
        "worktree /home/user/repo/.worktrees/detached",
        "HEAD def456",
        "",
      ].join("\n");

      mockExecFileResult(porcelain);
      const result = await list("/home/user/repo");
      expect(result).toHaveLength(2);
      expect(result[1]!.branch).toBeUndefined();
    });
  });

  describe("listFeatureWorktrees", () => {
    it("filters to feature/ branches only", async () => {
      const porcelain = [
        "worktree /repo",
        "HEAD abc",
        "branch refs/heads/main",
        "",
        "worktree /repo/.worktrees/feature/42-test",
        "HEAD def",
        "branch refs/heads/feature/42-test",
        "",
        "worktree /repo/.worktrees/refactor/99-cleanup",
        "HEAD ghi",
        "branch refs/heads/refactor/99-cleanup",
        "",
      ].join("\n");

      mockExecFileResult(porcelain);
      const result = await listFeatureWorktrees("/repo");
      expect(result).toHaveLength(1);
      expect(result[0]!.branch).toBe("feature/42-test");
    });

    it("excludes main working tree even when on a feature/ branch (#328)", async () => {
      const porcelain = [
        "worktree /repo",
        "HEAD abc",
        "branch refs/heads/feature/201-some-work",
        "",
        "worktree /repo/.worktrees/feature/42-test",
        "HEAD def",
        "branch refs/heads/feature/42-test",
        "",
      ].join("\n");

      mockExecFileResult(porcelain);
      const result = await listFeatureWorktrees("/repo");
      expect(result).toHaveLength(1);
      expect(result[0]!.branch).toBe("feature/42-test");
    });
  });

  describe("toKebabCase", () => {
    it("converts spaces to hyphens", () => {
      expect(toKebabCase("Hello World")).toBe("hello-world");
    });

    it("converts underscores to hyphens", () => {
      expect(toKebabCase("hello_world")).toBe("hello-world");
    });

    it("removes special characters", () => {
      expect(toKebabCase("Fix: bug #42")).toBe("fix-bug-42");
    });

    it("lowercases the result", () => {
      expect(toKebabCase("My Feature")).toBe("my-feature");
    });

    it("truncates to 40 characters", () => {
      const longStr = "a".repeat(50);
      expect(toKebabCase(longStr)).toHaveLength(40);
    });

    it("handles empty string", () => {
      expect(toKebabCase("")).toBe("");
    });
  });
});
