import { type ChildProcess } from "node:child_process";
import { killProcess } from "../test-utils/port-helpers.js";

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
  if (viteProcess) {
    await killProcess(viteProcess);
  }
}
