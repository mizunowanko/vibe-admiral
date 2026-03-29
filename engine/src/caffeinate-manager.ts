import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";

/**
 * Manages a `caffeinate` process to prevent macOS sleep while Units are active.
 *
 * - Spawns `caffeinate -di -w <Engine PID>` when the first Unit starts.
 * - Kills the process when the last Unit stops.
 * - `-w` flag ensures automatic cleanup if the Engine crashes.
 * - No-op on non-macOS platforms.
 */
export class CaffeinateManager {
  private caffeinateProcess: ChildProcess | null = null;
  private activeUnitCount = 0;
  private enabled: boolean;
  private onStatusChange: ((status: CaffeinateStatus) => void) | null = null;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  setOnStatusChange(handler: (status: CaffeinateStatus) => void): void {
    this.onStatusChange = handler;
  }

  setEnabled(enabled: boolean): void {
    const changed = this.enabled !== enabled;
    this.enabled = enabled;
    if (!changed) return;

    if (enabled && this.activeUnitCount > 0) {
      this.spawnCaffeinate();
    } else if (!enabled) {
      this.killCaffeinate();
    }
    this.emitStatus();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  isActive(): boolean {
    return this.caffeinateProcess !== null;
  }

  getStatus(): CaffeinateStatus {
    return { enabled: this.enabled, active: this.isActive() };
  }

  updateActiveUnitCount(count: number): void {
    const prevCount = this.activeUnitCount;
    this.activeUnitCount = count;

    if (!this.enabled) return;

    if (prevCount === 0 && count > 0) {
      this.spawnCaffeinate();
    } else if (prevCount > 0 && count === 0) {
      this.killCaffeinate();
    }
  }

  shutdown(): void {
    this.killCaffeinate();
  }

  private spawnCaffeinate(): void {
    if (this.caffeinateProcess) return;
    if (platform() !== "darwin") return;

    try {
      this.caffeinateProcess = spawn(
        "caffeinate",
        ["-di", "-w", String(process.pid)],
        { stdio: "ignore", detached: false },
      );

      this.caffeinateProcess.on("error", (err) => {
        console.warn("[caffeinate] Failed to spawn:", err.message);
        this.caffeinateProcess = null;
        this.emitStatus();
      });

      this.caffeinateProcess.on("exit", (_code) => {
        this.caffeinateProcess = null;
        this.emitStatus();
      });

      console.log(`[caffeinate] Sleep inhibited (pid=${this.caffeinateProcess.pid}, engine=${process.pid})`);
      this.emitStatus();
    } catch (err) {
      console.warn("[caffeinate] spawn error:", err);
      this.caffeinateProcess = null;
    }
  }

  private killCaffeinate(): void {
    if (!this.caffeinateProcess) return;

    try {
      this.caffeinateProcess.kill("SIGTERM");
    } catch {
      // Process may already be dead
    }
    console.log("[caffeinate] Sleep inhibition released");
    this.caffeinateProcess = null;
    this.emitStatus();
  }

  private emitStatus(): void {
    this.onStatusChange?.(this.getStatus());
  }
}

export interface CaffeinateStatus {
  enabled: boolean;
  active: boolean;
}
