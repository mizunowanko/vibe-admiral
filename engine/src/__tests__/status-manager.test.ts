import { describe, expect, it, vi, beforeEach } from "vitest";
import { StatusManager } from "../status-manager.js";
import type { Issue } from "../types.js";

// Mock the github module
vi.mock("../github.js", () => ({
  getIssue: vi.fn(),
  updateLabels: vi.fn(),
  closeIssue: vi.fn(),
}));

// Import mocked functions
import * as github from "../github.js";

const mockGetIssue = vi.mocked(github.getIssue);
const mockUpdateLabels = vi.mocked(github.updateLabels);
const mockCloseIssue = vi.mocked(github.closeIssue);

const REPO = "owner/repo";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    title: "Test issue",
    body: "",
    labels: [],
    state: "open",
    ...overrides,
  };
}

describe("StatusManager", () => {
  let manager: StatusManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new StatusManager();
  });

  describe("getStatus", () => {
    it("returns 'done' for closed issues", async () => {
      mockGetIssue.mockResolvedValue(makeIssue({ state: "closed" }));
      expect(await manager.getStatus(REPO, 1)).toBe("done");
    });

    it("returns 'ready' for issues with no status/ label", async () => {
      mockGetIssue.mockResolvedValue(
        makeIssue({ labels: ["type/feature"] }),
      );
      expect(await manager.getStatus(REPO, 1)).toBe("ready");
    });

    it("returns 'sortied' for issues with status/sortied label", async () => {
      mockGetIssue.mockResolvedValue(
        makeIssue({ labels: ["status/sortied"] }),
      );
      expect(await manager.getStatus(REPO, 1)).toBe("sortied");
    });

    it("returns 'ready' for issues with empty labels", async () => {
      mockGetIssue.mockResolvedValue(makeIssue({ labels: [] }));
      expect(await manager.getStatus(REPO, 1)).toBe("ready");
    });
  });

  describe("getCurrentStatusLabel", () => {
    it("returns the status/ label when present", async () => {
      mockGetIssue.mockResolvedValue(
        makeIssue({ labels: ["status/sortied", "type/feature"] }),
      );
      expect(await manager.getCurrentStatusLabel(REPO, 1)).toBe(
        "status/sortied",
      );
    });

    it("returns undefined when no status/ label", async () => {
      mockGetIssue.mockResolvedValue(makeIssue({ labels: ["type/feature"] }));
      expect(await manager.getCurrentStatusLabel(REPO, 1)).toBeUndefined();
    });
  });

  describe("transition", () => {
    it("transitions ready → sortied", async () => {
      mockGetIssue.mockResolvedValue(
        makeIssue({ labels: ["type/feature"] }),
      );
      await manager.transition(REPO, 1, "sortied");
      expect(mockUpdateLabels).toHaveBeenCalledWith(REPO, 1, {
        remove: undefined,
        add: "status/sortied",
      });
    });

    it("transitions sortied → done (removes label + closes)", async () => {
      mockGetIssue.mockResolvedValue(
        makeIssue({ labels: ["status/sortied"] }),
      );
      await manager.transition(REPO, 1, "done");
      expect(mockUpdateLabels).toHaveBeenCalledWith(REPO, 1, {
        remove: "status/sortied",
      });
      expect(mockCloseIssue).toHaveBeenCalledWith(REPO, 1);
    });

    it("transitions sortied → ready (rollback): just removes status/sortied", async () => {
      mockGetIssue.mockResolvedValue(
        makeIssue({ labels: ["status/sortied"] }),
      );
      await manager.transition(REPO, 1, "ready");
      expect(mockUpdateLabels).toHaveBeenCalledWith(REPO, 1, {
        remove: "status/sortied",
      });
    });

    it("is a no-op when already at target status", async () => {
      mockGetIssue.mockResolvedValue(
        makeIssue({ labels: ["type/feature"] }),
      );
      await manager.transition(REPO, 1, "ready");
      expect(mockUpdateLabels).not.toHaveBeenCalled();
    });

    it("throws on invalid transition (ready → done)", async () => {
      mockGetIssue.mockResolvedValue(
        makeIssue({ labels: ["type/feature"] }),
      );
      await expect(manager.transition(REPO, 1, "done")).rejects.toThrow(
        "Invalid status transition for #1: ready → done",
      );
    });

    it("throws on invalid transition (done → ready)", async () => {
      mockGetIssue.mockResolvedValue(makeIssue({ state: "closed" }));
      await expect(manager.transition(REPO, 1, "ready")).rejects.toThrow(
        "Invalid status transition for #1: done → ready",
      );
    });

    it("throws on concurrent transitions for the same issue", async () => {
      // Make getIssue hang to simulate a long-running transition
      let resolveGetIssue: (value: Issue) => void;
      mockGetIssue.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveGetIssue = resolve;
          }),
      );

      const first = manager.transition(REPO, 1, "sortied");
      const second = manager.transition(REPO, 1, "sortied");

      await expect(second).rejects.toThrow("Concurrent status transition");

      // Resolve the first to clean up
      resolveGetIssue!(makeIssue({ labels: [] }));
      await first;
    });
  });

  describe("rollback", () => {
    it("retries on failure with exponential backoff", async () => {
      mockGetIssue
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValue(makeIssue({ labels: ["status/sortied"] }));
      mockUpdateLabels.mockResolvedValue(undefined);

      await manager.rollback(REPO, 1, 1);
      expect(mockGetIssue).toHaveBeenCalledTimes(2);
    });

    it("logs error after exhausting retries", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockGetIssue.mockRejectedValue(new Error("persistent error"));

      await manager.rollback(REPO, 1, 0);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to rollback #1"),
        expect.any(Error),
      );
      consoleSpy.mockRestore();
    });
  });

  describe("isSortied", () => {
    it("returns true for sortied status", async () => {
      mockGetIssue.mockResolvedValue(
        makeIssue({ labels: ["status/sortied"] }),
      );
      expect(await manager.isSortied(REPO, 1)).toBe(true);
    });

    it("returns false for ready status (no status label)", async () => {
      mockGetIssue.mockResolvedValue(
        makeIssue({ labels: ["type/feature"] }),
      );
      expect(await manager.isSortied(REPO, 1)).toBe(false);
    });
  });
});
