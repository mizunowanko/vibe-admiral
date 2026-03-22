import { type FullConfig } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface E2EContext {
  engineProcess: ChildProcess;
  admiralHome: string;
  enginePort: number;
  vitePort: number;
}

function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Failed to get port")));
      }
    });
    server.on("error", reject);
  });
}

function waitForPort(port: number, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Port ${port} not ready within ${timeoutMs}ms`));
        return;
      }
      const socket = net.createConnection({ port, host: "localhost" });
      socket.on("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.on("error", () => {
        setTimeout(tryConnect, 500);
      });
    };
    tryConnect();
  });
}

export default async function globalSetup(config: FullConfig) {
  // Respect pre-set ports from env (the Playwright config reads these at
  // load time, so they must stay consistent between config and setup).
  const enginePort = process.env.E2E_ENGINE_PORT
    ? parseInt(process.env.E2E_ENGINE_PORT, 10)
    : await getRandomPort();
  const vitePort = process.env.E2E_VITE_PORT
    ? parseInt(process.env.E2E_VITE_PORT, 10)
    : await getRandomPort();
  const admiralHome = await mkdtemp(join(tmpdir(), "vibe-admiral-test-"));

  // Store context for teardown and test access
  const ctx: E2EContext = {
    engineProcess: null!,
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

  // Store for teardown
  (globalThis as Record<string, unknown>).__e2eContext = ctx;

  // Export ports via env for Playwright config and tests
  process.env.E2E_ENGINE_PORT = String(enginePort);
  process.env.E2E_VITE_PORT = String(vitePort);
  process.env.E2E_ADMIRAL_HOME = admiralHome;
}
