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

    it("returns 'todo' for issues with status/todo label", async () => {
      mockGetIssue.mockResolvedValue(
        makeIssue({ labels: ["status/todo", "type/feature"] }),
      );
      expect(await manager.getStatus(REPO, 1)).toBe("todo");
    });

    it("returns 'doing' for issues with any active status/ label", async () => {
      mockGetIssue.mockResolvedValue(
        makeIssue({ labels: ["status/implementing"] }),
      );
      expect(await manager.getStatus(REPO, 1)).toBe("doing");
    });

    it("returns 'todo' for issues with no status/ label", async () => {
      mockGetIssue.mockResolvedValue(makeIssue({ labels: ["type/feature"] }));
      expect(await manager.getStatus(REPO, 1)).toBe("todo");
    });
  });

  describe("getCurrentStatusLabel", () => {
    it("returns the status/ label when present", async () => {
      mockGetIssue.mockResolvedValue(
        makeIssue({ labels: ["status/implementing", "type/feature"] }),
      );
      expect(await manager.getCurrentStatusLabel(REPO, 1)).toBe(
        "status/implementing",
      );
    });

    it("returns undefined when no status/ label", async () => {
      mockGetIssue.mockResolvedValue(makeIssue({ labels: ["type/feature"] }));
      expect(await manager.getCurrentStatusLabel(REPO, 1)).toBeUndefined();
    });
  });

  describe("transition", () => {
    it("transitions todo → doing", async () => {
      mockGetIssue.mockResolvedValue(
        makeIssue({ labels: ["status/todo"] }),
      );
      await manager.transition(REPO, 1, "doing");
      expect(mockUpdateLabels).toHaveBeenCalledWith(REPO, 1, {
        remove: "status/todo",
        add: "status/planning",
      });
    });

    it("transitions doing → done (removes label + closes)", async () => {
      mockGetIssue.mockResolvedValue(
        makeIssue({ labels: ["status/implementing"] }),
      );
      await manager.transition(REPO, 1, "done");
      expect(mockUpdateLabels).toHaveBeenCalledWith(REPO, 1, {
        remove: "status/implementing",
      });
      expect(mockCloseIssue).toHaveBeenCalledWith(REPO, 1);
    });

    it("transitions doing → todo (rollback)", async () => {
      mockGetIssue.mockResolvedValue(
        makeIssue({ labels: ["status/implementing"] }),
      );
      await manager.transition(REPO, 1, "todo");
      expect(mockUpdateLabels).toHaveBeenCalledWith(REPO, 1, {
        remove: "status/implementing",
        add: "status/todo",
      });
    });

    it("is a no-op when already at target status", async () => {
      mockGetIssue.mockResolvedValue(
        makeIssue({ labels: ["status/todo"] }),
      );
      await manager.transition(REPO, 1, "todo");
      expect(mockUpdateLabels).not.toHaveBeenCalled();
    });

    it("throws on invalid transition (todo → done)", async () => {
      mockGetIssue.mockResolvedValue(
        makeIssue({ labels: ["status/todo"] }),
      );
      await expect(manager.transition(REPO, 1, "done")).rejects.toThrow(
        "Invalid status transition for #1: todo → done",
      );
    });

    it("throws on invalid transition (done → todo)", async () => {
      mockGetIssue.mockResolvedValue(makeIssue({ state: "closed" }));
      await expect(manager.transition(REPO, 1, "todo")).rejects.toThrow(
        "Invalid status transition for #1: done → todo",
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

      const first = manager.transition(REPO, 1, "doing");
      const second = manager.transition(REPO, 1, "doing");

      await expect(second).rejects.toThrow("Concurrent status transition");

      // Resolve the first to clean up
      resolveGetIssue!(makeIssue({ labels: ["status/todo"] }));
      await first;
    });
  });

  describe("rollback", () => {
    it("retries on failure with exponential backoff", async () => {
      mockGetIssue
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValue(makeIssue({ labels: ["status/implementing"] }));
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

  describe("isDoing", () => {
    it("returns true for doing status", async () => {
      mockGetIssue.mockResolvedValue(
        makeIssue({ labels: ["status/implementing"] }),
      );
      expect(await manager.isDoing(REPO, 1)).toBe(true);
    });

    it("returns false for todo status", async () => {
      mockGetIssue.mockResolvedValue(
        makeIssue({ labels: ["status/todo"] }),
      );
      expect(await manager.isDoing(REPO, 1)).toBe(false);
    });
  });

  describe("syncPhaseLabel", () => {
    it("replaces current status label with new phase label", async () => {
      mockGetIssue.mockResolvedValue(
        makeIssue({ labels: ["status/implementing"] }),
      );
      await manager.syncPhaseLabel(REPO, 1, "acceptance-test");
      expect(mockUpdateLabels).toHaveBeenCalledWith(REPO, 1, {
        remove: "status/implementing",
        add: "status/acceptance-test",
      });
    });

    it("skips update when phase has no corresponding label (done)", async () => {
      await manager.syncPhaseLabel(REPO, 1, "done");
      expect(mockUpdateLabels).not.toHaveBeenCalled();
    });

    it("skips update when label is already correct", async () => {
      mockGetIssue.mockResolvedValue(
        makeIssue({ labels: ["status/acceptance-test"] }),
      );
      await manager.syncPhaseLabel(REPO, 1, "acceptance-test");
      expect(mockUpdateLabels).not.toHaveBeenCalled();
    });
  });
});
