import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// Mock child_process.spawn before imports
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { spawn } from "node:child_process";
import { ProcessManager, isRetryableError } from "../process-manager.js";

/** Create a mock ChildProcess with readable stdout/stderr and writable stdin. */
function createMockProcess(opts?: { withStdin?: boolean }) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: opts?.withStdin
      ? { writable: true, write: vi.fn() }
      : null,
    pid: 12345,
    exitCode: null as null | number,
    kill: vi.fn(),
  });
  return proc;
}

describe("isRetryableError", () => {
  it("detects rate limit text", () => {
    expect(isRetryableError("Rate limit exceeded")).toBe(true);
    expect(isRetryableError("Error 429 Too Many Requests")).toBe(true);
    expect(isRetryableError("too many requests")).toBe(true);
    expect(isRetryableError("rate_limit_error")).toBe(true);
    expect(isRetryableError("APIError 429")).toBe(true);
  });

  it("detects overload and server errors", () => {
    expect(isRetryableError("Server overloaded")).toBe(true);
    expect(isRetryableError("Error 529")).toBe(true);
    expect(isRetryableError("Error 500")).toBe(true);
    expect(isRetryableError("Internal server error")).toBe(true);
    expect(isRetryableError("Service unavailable")).toBe(true);
  });

  it("detects transient auth failures", () => {
    expect(isRetryableError("Error 401 Unauthorized")).toBe(true);
  });

  it("returns false for non-retryable text", () => {
    expect(isRetryableError("Normal error")).toBe(false);
    expect(isRetryableError("File not found")).toBe(false);
    expect(isRetryableError("")).toBe(false);
  });
});

describe("ProcessManager", () => {
  let pm: ProcessManager;
  let mockProc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    vi.clearAllMocks();
    pm = new ProcessManager();
    mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);
  });

  afterEach(() => {
    pm.killAll();
  });

  describe("sortie", () => {
    it("spawns a Ship process with correct args and stdio", () => {
      pm.sortie("ship-001", "/worktree/path", 42);

      expect(spawn).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining([
          "-p",
          "/implement 42",
          "--output-format",
          "stream-json",
          "--dangerously-skip-permissions",
          "--disallowedTools",
          "EnterPlanMode,ExitPlanMode,AskUserQuestion",
          "--max-turns",
          "200",
          "--verbose",
        ]),
        expect.objectContaining({
          cwd: "/worktree/path",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
    });

    it("sets VIBE_ADMIRAL environment variables", () => {
      pm.sortie("ship-001", "/path", 42, undefined, undefined, {
        VIBE_ADMIRAL_MAIN_REPO: "owner/repo",
      });

      const callArgs = vi.mocked(spawn).mock.calls[0]!;
      const options = callArgs[2] as { env: Record<string, string> };
      expect(options.env.VIBE_ADMIRAL).toBe("true");
      expect(options.env.VIBE_ADMIRAL_SHIP_ID).toBe("ship-001");
      expect(options.env.VIBE_ADMIRAL_MAIN_REPO).toBe("owner/repo");
    });

    it("uses custom skill when provided", () => {
      pm.sortie("ship-001", "/path", 42, undefined, "/hotfix");

      const callArgs = vi.mocked(spawn).mock.calls[0]!;
      const args = callArgs[1] as string[];
      expect(args[1]).toBe("/hotfix 42");
    });

    it("appends extra prompt when provided", () => {
      pm.sortie("ship-001", "/path", 42, "extra context");

      const callArgs = vi.mocked(spawn).mock.calls[0]!;
      const args = callArgs[1] as string[];
      expect(args).toContain("--append-system-prompt");
      expect(args).toContain("extra context");
    });
  });

  describe("launchCommander", () => {
    it("spawns a Commander with stdin pipe and allowedTools", () => {
      mockProc = createMockProcess({ withStdin: true });
      vi.mocked(spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

      pm.launchCommander("flagship-fleet1", "/fleet/path", ["/extra/dir"], "system prompt");

      expect(spawn).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining([
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--allowedTools",
          "Bash,Read,Glob,Grep,WebSearch,WebFetch,AskUserQuestion,Agent",
          "--append-system-prompt",
          "system prompt",
          "--add-dir",
          "/extra/dir",
        ]),
        expect.objectContaining({
          cwd: "/fleet/path",
          stdio: ["pipe", "pipe", "pipe"],
        }),
      );
    });
  });

  describe("resumeSession", () => {
    it("spawns a resume with --resume flag and stdin ignored", () => {
      pm.resumeSession("ship-001", "session-abc", "Continue", "/cwd", {
        VIBE_ADMIRAL_ENGINE_PORT: "9721",
      });

      expect(spawn).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining([
          "--resume",
          "session-abc",
          "-p",
          "Continue",
          "--output-format",
          "stream-json",
        ]),
        expect.objectContaining({
          cwd: "/cwd",
          stdio: ["ignore", "pipe", "pipe"],
          env: expect.objectContaining({
            VIBE_ADMIRAL: "true",
            VIBE_ADMIRAL_SHIP_ID: "ship-001",
            VIBE_ADMIRAL_ENGINE_PORT: "9721",
          }),
        }),
      );
    });
  });

  describe("resumeCommander", () => {
    it("spawns a commander resume with --resume and stdin pipe", () => {
      mockProc = createMockProcess({ withStdin: true });
      vi.mocked(spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

      pm.resumeCommander("dock-fleet1", "sess-xyz", "/fleet", []);

      expect(spawn).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining([
          "--resume",
          "sess-xyz",
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
        ]),
        expect.objectContaining({
          cwd: "/fleet",
          stdio: ["pipe", "pipe", "pipe"],
        }),
      );
    });
  });

  describe("stdout line buffering and data events", () => {
    it("emits parsed JSON messages on newline-delimited stdout", async () => {
      const messages: Array<[string, Record<string, unknown>]> = [];
      pm.on("data", (id: string, msg: Record<string, unknown>) => {
        messages.push([id, msg]);
      });

      pm.sortie("ship-001", "/path", 42);

      // Simulate chunked stdout
      const line1 = JSON.stringify({ type: "assistant", content: "Hello" });
      const line2 = JSON.stringify({ type: "tool_use", tool: "Read" });

      mockProc.stdout.emit("data", Buffer.from(line1 + "\n" + line2 + "\n"));

      expect(messages).toHaveLength(2);
      expect(messages[0]![1]).toEqual({ type: "assistant", content: "Hello" });
      expect(messages[1]![1]).toEqual({ type: "tool_use", tool: "Read" });
    });

    it("handles partial chunks across multiple data events", () => {
      const messages: Array<Record<string, unknown>> = [];
      pm.on("data", (_id: string, msg: Record<string, unknown>) => {
        messages.push(msg);
      });

      pm.sortie("ship-001", "/path", 42);

      const fullLine = JSON.stringify({ type: "assistant", content: "Partial test" });
      const half1 = fullLine.slice(0, 15);
      const half2 = fullLine.slice(15) + "\n";

      mockProc.stdout.emit("data", Buffer.from(half1));
      expect(messages).toHaveLength(0);

      mockProc.stdout.emit("data", Buffer.from(half2));
      expect(messages).toHaveLength(1);
      expect(messages[0]!.content).toBe("Partial test");
    });

    it("ignores non-JSON lines", () => {
      const messages: Array<Record<string, unknown>> = [];
      pm.on("data", (_id: string, msg: Record<string, unknown>) => {
        messages.push(msg);
      });

      pm.sortie("ship-001", "/path", 42);

      mockProc.stdout.emit("data", Buffer.from("not json\n{\"type\":\"ok\"}\n"));
      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe("ok");
    });
  });

  describe("stderr and error events", () => {
    it("emits rate-limit on retryable stderr content", () => {
      const rateLimitHandler = vi.fn();
      const errorHandler = vi.fn();
      pm.on("rate-limit", rateLimitHandler);
      pm.on("error", errorHandler); // Must handle error event to avoid unhandled throw

      pm.sortie("ship-001", "/path", 42);

      mockProc.stderr!.emit("data", Buffer.from("Error 429 Too Many Requests"));
      expect(rateLimitHandler).toHaveBeenCalledWith("ship-001");
      // error is also emitted alongside rate-limit
      expect(errorHandler).toHaveBeenCalledWith("ship-001", expect.any(Error));
    });

    it("emits error event for all stderr content", () => {
      const errorHandler = vi.fn();
      pm.on("error", errorHandler);

      pm.sortie("ship-001", "/path", 42);

      mockProc.stderr!.emit("data", Buffer.from("Something went wrong"));
      expect(errorHandler).toHaveBeenCalledWith("ship-001", expect.any(Error));
    });
  });

  describe("process exit", () => {
    it("emits exit event and cleans up process map", () => {
      const exitHandler = vi.fn();
      pm.on("exit", exitHandler);

      pm.sortie("ship-001", "/path", 42);
      expect(pm.isRunning("ship-001")).toBe(true);

      mockProc.emit("exit", 0);
      expect(exitHandler).toHaveBeenCalledWith("ship-001", 0);
      expect(pm.isRunning("ship-001")).toBe(false);
    });

    it("handles process spawn error", () => {
      const errorHandler = vi.fn();
      pm.on("error", errorHandler);

      pm.sortie("ship-001", "/path", 42);

      mockProc.emit("error", new Error("ENOENT: claude not found"));
      expect(errorHandler).toHaveBeenCalledWith("ship-001", expect.any(Error));
      expect(pm.isRunning("ship-001")).toBe(false);
    });
  });

  describe("sendMessage", () => {
    it("writes stream-json formatted message to stdin", () => {
      mockProc = createMockProcess({ withStdin: true });
      vi.mocked(spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

      pm.launchCommander("flagship-fleet1", "/fleet", []);

      pm.sendMessage("flagship-fleet1", "Hello Commander");

      expect(mockProc.stdin!.write).toHaveBeenCalledWith(
        expect.stringContaining('"type":"user"'),
      );
      const written = mockProc.stdin!.write.mock.calls[0]![0] as string;
      const parsed = JSON.parse(written.trim());
      expect(parsed.message.role).toBe("user");
      expect(parsed.message.content).toBe("Hello Commander");
    });

    it("includes images in content array when provided", () => {
      mockProc = createMockProcess({ withStdin: true });
      vi.mocked(spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

      pm.launchCommander("flagship-fleet1", "/fleet", []);

      pm.sendMessage("flagship-fleet1", "Check this", [
        { base64: "abc123", mediaType: "image/png" },
      ]);

      const written = mockProc.stdin!.write.mock.calls[0]![0] as string;
      const parsed = JSON.parse(written.trim());
      expect(parsed.message.content).toEqual([
        { type: "text", text: "Check this" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
      ]);
    });

    it("returns null when process not found", () => {
      const result = pm.sendMessage("nonexistent", "Hello");
      expect(result).toBeNull();
    });
  });

  describe("sendToolResult", () => {
    it("writes tool_result formatted message to stdin", () => {
      mockProc = createMockProcess({ withStdin: true });
      vi.mocked(spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

      pm.launchCommander("flagship-fleet1", "/fleet", []);

      pm.sendToolResult("flagship-fleet1", "tool-use-123", "The answer is 42");

      const written = mockProc.stdin!.write.mock.calls[0]![0] as string;
      const parsed = JSON.parse(written.trim());
      expect(parsed.message.content).toEqual([
        {
          type: "tool_result",
          tool_use_id: "tool-use-123",
          content: "The answer is 42",
          is_error: false,
        },
      ]);
    });
  });

  describe("kill", () => {
    it("sends SIGTERM and removes from process map", () => {
      pm.sortie("ship-001", "/path", 42);

      const result = pm.kill("ship-001");
      expect(result).toBe(true);
      expect(mockProc.kill).toHaveBeenCalledWith("SIGTERM");
      expect(pm.isRunning("ship-001")).toBe(false);
    });

    it("returns false for non-existent process", () => {
      expect(pm.kill("nonexistent")).toBe(false);
    });
  });

  describe("killAll", () => {
    it("kills all tracked processes", () => {
      const proc1 = createMockProcess();
      const proc2 = createMockProcess();
      vi.mocked(spawn)
        .mockReturnValueOnce(proc1 as unknown as ReturnType<typeof spawn>)
        .mockReturnValueOnce(proc2 as unknown as ReturnType<typeof spawn>);

      pm.sortie("ship-001", "/path1", 1);
      pm.sortie("ship-002", "/path2", 2);

      pm.killAll();
      expect(proc1.kill).toHaveBeenCalledWith("SIGTERM");
      expect(proc2.kill).toHaveBeenCalledWith("SIGTERM");
      expect(pm.isRunning("ship-001")).toBe(false);
      expect(pm.isRunning("ship-002")).toBe(false);
    });
  });

  describe("isRunning", () => {
    it("returns true for a process with null exitCode", () => {
      pm.sortie("ship-001", "/path", 42);
      expect(pm.isRunning("ship-001")).toBe(true);
    });

    it("returns false after process exits", () => {
      pm.sortie("ship-001", "/path", 42);
      mockProc.emit("exit", 0);
      expect(pm.isRunning("ship-001")).toBe(false);
    });

    it("returns false for unknown process", () => {
      expect(pm.isRunning("unknown")).toBe(false);
    });
  });

  describe("getPid", () => {
    it("returns pid for tracked process", () => {
      pm.sortie("ship-001", "/path", 42);
      expect(pm.getPid("ship-001")).toBe(12345);
    });

    it("returns undefined for unknown process", () => {
      expect(pm.getPid("unknown")).toBeUndefined();
    });
  });
});
