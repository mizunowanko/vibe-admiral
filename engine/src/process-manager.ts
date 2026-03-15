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
    const proc = spawn(
      "claude",
      [
        "-p",
        `/implement ${issueNumber}`,
        "--output-format",
        "stream-json",
        "--dangerously-skip-permissions",
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
        stdio: ["pipe", "pipe", "pipe"],
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
      systemPrompt ?? "",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "plan",
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
      ],
      {
        cwd,
        env: {
          ...process.env,
          VIBE_ADMIRAL: "true",
        },
        stdio: ["pipe", "pipe", "pipe"],
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

  private setupProcess(id: string, proc: ChildProcess): void {
    this.processes.set(id, proc);

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
        this.emit("error", id, new Error(text));
      }
    });

    proc.on("exit", (code) => {
      this.processes.delete(id);
      this.emit("exit", id, code);
    });

    proc.on("error", (err) => {
      this.processes.delete(id);
      this.emit("error", id, err);
    });
  }
}
