import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAdmiralHome } from "./admiral-home.js";
import {
  isRetryableError,
  isRateLimitError,
  attachStdoutProcessor,
  attachStderrProcessor,
} from "./stream-processor.js";

export { isRetryableError, isRateLimitError };

export const COMMANDER_ALLOWED_TOOLS =
  "Bash,Read,Glob,Grep,WebSearch,WebFetch";

export type SendResult =
  | { ok: true }
  | { ok: false; reason: "not-writable" | "process-not-found" };

export interface ProcessEvents {
  data: (id: string, message: Record<string, unknown>) => void;
  exit: (id: string, code: number | null) => void;
  error: (id: string, error: Error) => void;
  "rate-limit": (id: string) => void;
  spawn: (id: string) => void;
}

export interface ProcessManagerLike {
  sortie(
    id: string,
    worktreePath: string,
    issueNumber: number,
    extraPrompt?: string,
    skill?: string,
    extraEnv?: Record<string, string>,
  ): void;
  dispatchSortie(
    id: string,
    cwd: string,
    prompt: string,
    type: "investigate" | "modify",
    extraEnv?: Record<string, string>,
  ): void;
  launchCommander(
    id: string,
    fleetPath: string,
    additionalDirs: string[],
    systemPrompt?: string,
    extraEnv?: Record<string, string>,
  ): void;
  resumeCommander(
    id: string,
    sessionId: string,
    fleetPath: string,
    additionalDirs: string[],
    systemPrompt?: string,
    extraEnv?: Record<string, string>,
  ): void;
  resumeSession(
    id: string,
    sessionId: string,
    message: string,
    cwd: string,
    extraEnv?: Record<string, string>,
    appendSystemPrompt?: string,
    logFileName?: string,
  ): void;

  sendMessage(
    id: string,
    message: string,
    images?: Array<{ base64: string; mediaType: string }>,
  ): SendResult;
  sendToolResult(id: string, toolUseId: string, result: string): SendResult;

  kill(id: string): boolean;
  killAll(): void;

  isRunning(id: string): boolean;
  getActiveCount(): number;
  getPid(id: string): number | undefined;

  // Typed overloads for ProcessEvents
  on<K extends keyof ProcessEvents>(event: K, listener: ProcessEvents[K]): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this;
  emit<K extends keyof ProcessEvents>(event: K, ...args: Parameters<ProcessEvents[K]>): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emit(event: string, ...args: any[]): boolean;
  removeAllListeners(event?: string): this;
}

const CLI_PATH = process.env.CLAUDE_CLI_PATH ?? "claude";

export class ProcessManager extends EventEmitter {
  private processes = new Map<string, ChildProcess>();

  sortie(
    id: string,
    worktreePath: string,
    issueNumber: number,
    extraPrompt?: string,
    skill?: string,
    extraEnv?: Record<string, string>,
  ): ChildProcess {
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
      CLI_PATH,
      args,
      {
        cwd: worktreePath,
        env: {
          ...process.env,
          VIBE_ADMIRAL: "true",
          VIBE_ADMIRAL_SHIP_ID: id,
          ...extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const isEscort = skill?.startsWith("/escort-") ?? false;
    const logFileName = isEscort ? "escort-log.jsonl" : "ship-log.jsonl";
    const logFilePath = join(worktreePath, ".claude", logFileName);
    this.setupProcess(id, proc, logFilePath);
    return proc;
  }

  dispatchSortie(
    id: string,
    cwd: string,
    prompt: string,
    type: "investigate" | "modify",
    extraEnv?: Record<string, string>,
  ): ChildProcess {
    const allowedTools = type === "investigate"
      ? "Bash,Read,Glob,Grep,WebSearch,WebFetch"
      : "Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch";

    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--allowedTools",
      allowedTools,
      "--max-turns",
      "100",
      "--verbose",
    ];

    const proc = spawn(CLI_PATH, args, {
      cwd,
      env: {
        ...process.env,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const logFilePath = join(getAdmiralHome(), "dispatches", `dispatch-log-${id}.jsonl`);
    this.setupProcess(id, proc, logFilePath);
    return proc;
  }

  launchCommander(
    id: string,
    fleetPath: string,
    additionalDirs: string[],
    systemPrompt?: string,
    extraEnv?: Record<string, string>,
  ): ChildProcess {
    const args = [
      "-p",
      "",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--allowedTools",
      COMMANDER_ALLOWED_TOOLS,
      ...(systemPrompt
        ? ["--append-system-prompt", systemPrompt]
        : []),
      ...additionalDirs.flatMap((d) => ["--add-dir", d]),
    ];

    const proc = spawn(CLI_PATH, args, {
      cwd: fleetPath,
      env: {
        ...process.env,
        VIBE_ADMIRAL_DB_PATH: join(getAdmiralHome(), "fleet.db"),
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.setupProcess(id, proc);
    return proc;
  }

  sendMessage(
    id: string,
    message: string,
    images?: Array<{ base64: string; mediaType: string }>,
  ): SendResult {
    const proc = this.processes.get(id);
    if (!proc) return { ok: false, reason: "process-not-found" };
    if (!proc.stdin?.writable) return { ok: false, reason: "not-writable" };

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
    return { ok: true };
  }

  sendToolResult(
    id: string,
    toolUseId: string,
    result: string,
  ): SendResult {
    const proc = this.processes.get(id);
    if (!proc) return { ok: false, reason: "process-not-found" };
    if (!proc.stdin?.writable) return { ok: false, reason: "not-writable" };
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
    return { ok: true };
  }

  resumeCommander(
    id: string,
    sessionId: string,
    fleetPath: string,
    additionalDirs: string[],
    systemPrompt?: string,
    extraEnv?: Record<string, string>,
  ): ChildProcess {
    const args = [
      "--resume",
      sessionId,
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--allowedTools",
      COMMANDER_ALLOWED_TOOLS,
      ...(systemPrompt
        ? ["--append-system-prompt", systemPrompt]
        : []),
      ...additionalDirs.flatMap((d) => ["--add-dir", d]),
    ];

    const proc = spawn(CLI_PATH, args, {
      cwd: fleetPath,
      env: {
        ...process.env,
        VIBE_ADMIRAL_DB_PATH: join(getAdmiralHome(), "fleet.db"),
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.setupProcess(id, proc);
    return proc;
  }

  resumeSession(
    id: string,
    sessionId: string,
    message: string,
    cwd: string,
    extraEnv?: Record<string, string>,
    appendSystemPrompt?: string,
    logFileName?: string,
  ): ChildProcess {
    const args = [
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
    ];

    if (appendSystemPrompt) {
      args.push("--append-system-prompt", appendSystemPrompt);
    }

    const proc = spawn(
      "claude",
      args,
      {
        cwd,
        env: {
          ...process.env,
          VIBE_ADMIRAL: "true",
          VIBE_ADMIRAL_SHIP_ID: id,
          ...extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const logFilePath = join(cwd, ".claude", logFileName ?? "ship-log.jsonl");
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

  getActiveCount(): number {
    return this.processes.size;
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
    this.emit("spawn", id);
    const shortId = id.slice(0, 8);

    if (logFilePath) {
      try {
        mkdirSync(dirname(logFilePath), { recursive: true });
      } catch {
        // Best-effort: directory may already exist
      }
    }

    console.log(`[proc:${shortId}] spawned (pid=${proc.pid})`);

    const callbacks = {
      onMessage: (msg: Record<string, unknown>) => {
        this.emit("data", id, msg);
      },
      onRetryableError: () => {
        this.emit("rate-limit", id);
      },
      onError: (error: Error) => {
        this.emit("error", id, error);
      },
    };

    attachStdoutProcessor(proc, shortId, logFilePath, callbacks);
    attachStderrProcessor(proc, shortId, callbacks);

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
