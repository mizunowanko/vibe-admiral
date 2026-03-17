import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Rate limit patterns in stderr / error output from Claude CLI. */
const RATE_LIMIT_PATTERNS = [
  /rate.?limit/i,
  /429/,
  /too many requests/i,
  /overloaded/i,
  /rate_limit_error/i,
  /APIError.*429/i,
];

export function isRateLimitError(text: string): boolean {
  return RATE_LIMIT_PATTERNS.some((p) => p.test(text));
}

export interface ProcessEvents {
  data: (id: string, message: Record<string, unknown>) => void;
  exit: (id: string, code: number | null) => void;
  error: (id: string, error: Error) => void;
  "rate-limit": (id: string) => void;
}

export class ProcessManager extends EventEmitter {
  private processes = new Map<string, ChildProcess>();

  sortie(
    id: string,
    worktreePath: string,
    issueNumber: number,
    extraPrompt?: string,
    skill?: string,
  ): ChildProcess {
    // See .claude/rules/cli-subprocess.md for full rationale.
    //
    // stdio: stdin MUST be 'ignore' — Bun replaces pipe FDs with Unix
    // sockets when stdin is a pipe, breaking stdout capture.
    //
    // disallowedTools:
    //   EnterPlanMode/ExitPlanMode — in -p mode, plan mode causes CLI
    //     to exit after ExitPlanMode without performing implementation.
    //   AskUserQuestion — Ship runs non-interactively (stdin ignored);
    //     user interaction uses file message board instead.
    const skillCmd = skill ?? "/implement";
    const args = [
      "-p",
      `${skillCmd} ${issueNumber}`,
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--disallowedTools",
      "EnterPlanMode,ExitPlanMode,AskUserQuestion",
      "--max-turns",
      "200",
      "--verbose",
    ];

    if (extraPrompt) {
      args.push("--append-system-prompt", extraPrompt);
    }

    const proc = spawn(
      "claude",
      args,
      {
        cwd: worktreePath,
        env: {
          ...process.env,
          VIBE_ADMIRAL: "true",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const logFilePath = join(worktreePath, ".claude", "ship-log.jsonl");
    this.setupProcess(id, proc, logFilePath);
    return proc;
  }

  launchBridge(
    id: string,
    fleetPath: string,
    additionalDirs: string[],
    systemPrompt?: string,
  ): ChildProcess {
    // See .claude/rules/cli-subprocess.md for full rationale.
    //
    // stdio: stdin IS a pipe (interactive messaging via stream-json).
    // MUST write to stdin immediately after spawn — Bun blocks stdout
    // when stdin pipe is idle, creating a deadlock if you wait for init.
    //
    // allowedTools: Bridge is read-only (no Write/Edit). AskUserQuestion
    // is allowed — Engine intercepts it and forwards to frontend.
    const args = [
      "-p",
      "",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--allowedTools",
      "Bash,Read,Glob,Grep,WebSearch,WebFetch,AskUserQuestion,Task,TaskOutput",
      ...(systemPrompt
        ? ["--append-system-prompt", systemPrompt]
        : []),
      ...additionalDirs.flatMap((d) => ["--add-dir", d]),
    ];

    const proc = spawn("claude", args, {
      cwd: fleetPath,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.setupProcess(id, proc);
    return proc;
  }

  sendMessage(
    id: string,
    message: string,
    images?: Array<{ base64: string; mediaType: string }>,
  ): ChildProcess | null {
    const proc = this.processes.get(id);
    if (!proc?.stdin?.writable) return null;

    let content: string | Array<Record<string, unknown>> = message;
    if (images && images.length > 0) {
      content = [
        { type: "text", text: message },
        ...images.map((img) => ({
          type: "image",
          source: {
            type: "base64",
            media_type: img.mediaType,
            data: img.base64,
          },
        })),
      ];
    }

    const payload = JSON.stringify({
      type: "user",
      message: { role: "user", content },
    });
    proc.stdin.write(payload + "\n");
    return proc;
  }

  sendToolResult(
    id: string,
    toolUseId: string,
    result: string,
  ): ChildProcess | null {
    const proc = this.processes.get(id);
    if (!proc?.stdin?.writable) return null;
    const payload = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: result,
            is_error: false,
          },
        ],
      },
    });
    proc.stdin.write(payload + "\n");
    return proc;
  }

  resumeSession(
    id: string,
    sessionId: string,
    message: string,
    cwd: string,
  ): ChildProcess {
    // Same stdio/disallowedTools constraints as sortie().
    // See .claude/rules/cli-subprocess.md for full rationale.
    const proc = spawn(
      "claude",
      [
        "--resume",
        sessionId,
        "-p",
        message,
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--disallowedTools",
        "EnterPlanMode,ExitPlanMode,AskUserQuestion",
      ],
      {
        cwd,
        env: {
          ...process.env,
          VIBE_ADMIRAL: "true",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const logFilePath = join(cwd, ".claude", "ship-log.jsonl");
    this.setupProcess(id, proc, logFilePath);
    return proc;
  }

  kill(id: string): boolean {
    const proc = this.processes.get(id);
    if (!proc) return false;
    proc.kill("SIGTERM");
    this.processes.delete(id);
    return true;
  }

  killAll(): void {
    for (const [id, proc] of this.processes) {
      proc.kill("SIGTERM");
      this.processes.delete(id);
    }
  }

  isRunning(id: string): boolean {
    const proc = this.processes.get(id);
    return proc !== undefined && proc.exitCode === null;
  }

  getPid(id: string): number | undefined {
    return this.processes.get(id)?.pid;
  }

  private setupProcess(
    id: string,
    proc: ChildProcess,
    logFilePath?: string,
  ): void {
    this.processes.set(id, proc);
    const shortId = id.slice(0, 8);

    // Ensure log directory exists for Ship log persistence
    if (logFilePath) {
      try {
        mkdirSync(dirname(logFilePath), { recursive: true });
      } catch {
        // Best-effort: directory may already exist
      }
    }

    console.log(`[proc:${shortId}] spawned (pid=${proc.pid})`);

    let buffer = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          this.emit("data", id, msg);

          // Persist Ship log: skip system init/hook messages (noisy, may contain env info)
          if (logFilePath && !(msg.type === "system" && msg.subtype === "init")) {
            try {
              appendFileSync(logFilePath, line + "\n");
            } catch {
              // Best-effort: don't crash on write failure
            }
          }
        } catch {
          // Non-JSON output, ignore
        }
      }
    });

    let stderrBuffer = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
      const text = stderrBuffer.trim();
      if (text) {
        console.error(`[proc:${shortId}] stderr: ${text.slice(0, 200)}`);
        if (isRateLimitError(text)) {
          this.emit("rate-limit", id);
        }
        this.emit("error", id, new Error(text));
        stderrBuffer = "";
      }
    });

    proc.on("exit", (code) => {
      console.log(`[proc:${shortId}] exited (code=${code})`);
      this.processes.delete(id);
      this.emit("exit", id, code);
    });

    proc.on("error", (err) => {
      console.error(`[proc:${shortId}] error: ${err.message}`);
      this.processes.delete(id);
      this.emit("error", id, err);
    });
  }
}
