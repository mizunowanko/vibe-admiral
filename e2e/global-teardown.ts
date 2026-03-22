import { rm } from "node:fs/promises";
import { type ChildProcess } from "node:child_process";

interface E2EContext {
  engineProcess: ChildProcess;
  admiralHome: string;
  enginePort: number;
  vitePort: number;
}

export default async function globalTeardown() {
  const ctx = (globalThis as Record<string, unknown>).__e2eContext as
    | E2EContext
    | undefined;

  if (!ctx) return;

  // Kill Engine process
  if (ctx.engineProcess && !ctx.engineProcess.killed) {
    ctx.engineProcess.kill("SIGTERM");
    // Wait briefly for graceful shutdown
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        ctx.engineProcess.kill("SIGKILL");
        resolve();
      }, 5000);
      ctx.engineProcess.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    console.log("E2E Engine stopped");
  }

  // Clean up temporary ADMIRAL_HOME
  if (ctx.admiralHome) {
    await rm(ctx.admiralHome, { recursive: true, force: true });
    console.log(`Cleaned up ${ctx.admiralHome}`);
  }
}
