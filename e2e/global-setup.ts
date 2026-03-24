import { type FullConfig } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getAvailablePort, waitForPort } from "../test-utils/port-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface E2EContext {
  engineProcess: ChildProcess;
  viteProcess: ChildProcess;
  admiralHome: string;
  enginePort: number;
  vitePort: number;
}

export default async function globalSetup(config: FullConfig) {
  const enginePort = await getAvailablePort("E2E_ENGINE_PORT");
  const vitePort = await getAvailablePort("E2E_VITE_PORT");
  const admiralHome = await mkdtemp(join(tmpdir(), "vibe-admiral-test-"));

  // Store context for teardown and test access
  const ctx: E2EContext = {
    engineProcess: null!,
    viteProcess: null!,
    admiralHome,
    enginePort,
    vitePort,
  };

  // Start the real Engine
  // Use __dirname to resolve the project root reliably, since
  // config.rootDir may not match when running from a worktree.
  const projectRoot = resolve(__dirname, "..");
  const engineProcess = spawn("npx", ["tsx", "engine/src/index.ts"], {
    env: {
      ...process.env,
      ENGINE_PORT: String(enginePort),
      ADMIRAL_HOME: admiralHome,
    },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: projectRoot,
  });

  engineProcess.stderr?.on("data", (chunk: Buffer) => {
    const msg = chunk.toString();
    if (msg.trim()) {
      console.error(`[engine:stderr] ${msg.trimEnd()}`);
    }
  });

  engineProcess.stdout?.on("data", (chunk: Buffer) => {
    const msg = chunk.toString();
    if (msg.trim()) {
      console.log(`[engine:stdout] ${msg.trimEnd()}`);
    }
  });

  ctx.engineProcess = engineProcess;

  // Wait for Engine to be ready
  await waitForPort(enginePort);
  console.log(`E2E Engine started on port ${enginePort}`);

  // Start Vite dev server with isolated ports
  const viteProcess = spawn("npx", ["vite", "--port", String(vitePort)], {
    env: {
      ...process.env,
      VITE_PORT: String(vitePort),
      VITE_ENGINE_PORT: String(enginePort),
    },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: projectRoot,
  });

  viteProcess.stderr?.on("data", (chunk: Buffer) => {
    const msg = chunk.toString();
    if (msg.trim()) {
      console.error(`[vite:stderr] ${msg.trimEnd()}`);
    }
  });

  ctx.viteProcess = viteProcess;

  // Wait for Vite to be ready
  await waitForPort(vitePort);
  console.log(`E2E Vite started on port ${vitePort}`);

  // Store for teardown
  (globalThis as Record<string, unknown>).__e2eContext = ctx;

  // Export ports via env for tests
  process.env.E2E_ENGINE_PORT = String(enginePort);
  process.env.E2E_VITE_PORT = String(vitePort);
  process.env.E2E_ADMIRAL_HOME = admiralHome;
}
