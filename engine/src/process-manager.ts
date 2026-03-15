import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

export interface ProcessEvents {
  data: (id: string, message: Record<string, unknown>) => void;
  exit: (id: string, code: number | null) => void;
  error: (id: string, error: Error) => void;
}

export class ProcessManager extends EventEmitter {
  private processes = new Map<string, ChildProcess>();

  sortie(
    id: string,
    worktreePath: string,
    issueNumber: number,
  ): ChildProcess {
    // stdin must be 'ignore' — Bun-based Claude CLI replaces pipe FDs
    // with unix sockets when stdin is a pipe, breaking stdout capture.
    const proc = spawn(
      "claude",
      [
        "-p",
        `/implement ${issueNumber}`,
        "--output-format",
        "stream-json",
        "--dangerously-skip-permissions",
        "--disallowedTools",
        "EnterPlanMode,ExitPlanMode",
        "--max-turns",
        "200",
        "--verbose",
      ],
      {
        cwd: worktreePath,
        env: {
          ...process.env,
          VIBE_ADMIRAL: "true",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    this.setupProcess(id, proc);
    return proc;
  }

  launchBridge(
    id: string,
    fleetPath: string,
    additionalDirs: string[],
    systemPrompt?: string,
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
      "Read,Glob,Grep,WebSearch,WebFetch,AskUserQuestion,Task,TaskOutput",
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

  sendMessage(id: string, message: string): ChildProcess | null {
    const proc = this.processes.get(id);
    if (!proc?.stdin?.writable) return null;
    const payload = JSON.stringify({
      type: "user",
      message: { role: "user", content: message },
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
    // stdin must be 'ignore' — same Bun pipe issue as sortie()
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
        "EnterPlanMode,ExitPlanMode",
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

    this.setupProcess(id, proc);
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

  private setupProcess(id: string, proc: ChildProcess): void {
    this.processes.set(id, proc);
    const shortId = id.slice(0, 8);

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
        } catch {
          // Non-JSON output, ignore
        }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        console.error(`[proc:${shortId}] stderr: ${text.slice(0, 200)}`);
        this.emit("error", id, new Error(text));
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
