import { rm } from "node:fs/promises";
import { type ChildProcess } from "node:child_process";
import { killProcess } from "../test-utils/port-helpers.js";

interface E2EContext {
  engineProcess: ChildProcess;
  viteProcess: ChildProcess;
  admiralHome: string;
  enginePort: number;
  vitePort: number;
}

export default async function globalTeardown() {
  const ctx = (globalThis as Record<string, unknown>).__e2eContext as
    | E2EContext
    | undefined;

  if (!ctx) return;

  // Kill Vite process
  if (ctx.viteProcess) {
    await killProcess(ctx.viteProcess);
    console.log("E2E Vite stopped");
  }

  // Kill Engine process
  if (ctx.engineProcess) {
    await killProcess(ctx.engineProcess);
    console.log("E2E Engine stopped");
  }

  // Clean up temporary ADMIRAL_HOME
  if (ctx.admiralHome) {
    await rm(ctx.admiralHome, { recursive: true, force: true });
    console.log(`Cleaned up ${ctx.admiralHome}`);
  }
}
