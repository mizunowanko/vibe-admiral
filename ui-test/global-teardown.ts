import { type ChildProcess } from "node:child_process";

export default async function globalTeardown() {
  const engine = (globalThis as Record<string, unknown>).__mockEngine as {
    close: () => Promise<void>;
  } | undefined;
  if (engine) {
    await engine.close();
  }

  const viteProcess = (globalThis as Record<string, unknown>).__viteProcess as
    | ChildProcess
    | undefined;
  if (viteProcess && !viteProcess.killed) {
    viteProcess.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        viteProcess.kill("SIGKILL");
        resolve();
      }, 5000);
      viteProcess.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}
