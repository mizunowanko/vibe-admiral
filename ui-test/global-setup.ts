import { MockEngine } from "./mock-engine";
import { spawn, type ChildProcess } from "node:child_process";
import { getAvailablePort, waitForPort } from "../test-utils/port-helpers.js";

export default async function globalSetup() {
  const enginePort = await getAvailablePort();
  const vitePort = await getAvailablePort();

  // Start mock engine on dynamic port
  const mockEngine = new MockEngine(enginePort);

  // Start Vite dev server with isolated ports
  const viteProcess = spawn("npx", ["vite", "--port", String(vitePort)], {
    env: {
      ...process.env,
      VITE_PORT: String(vitePort),
      VITE_ENGINE_PORT: String(enginePort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  viteProcess.stderr?.on("data", (chunk: Buffer) => {
    const msg = chunk.toString();
    if (msg.trim()) {
      console.error(`[vite:stderr] ${msg.trimEnd()}`);
    }
  });

  // Wait for Vite to be ready
  await waitForPort(vitePort);

  // Store references for teardown
  (globalThis as Record<string, unknown>).__mockEngine = mockEngine;
  (globalThis as Record<string, unknown>).__viteProcess = viteProcess;
  (globalThis as Record<string, unknown>).__vitePort = vitePort;

  // Export ports for test files
  process.env.UI_TEST_ENGINE_PORT = String(enginePort);
  process.env.UI_TEST_VITE_PORT = String(vitePort);
}
