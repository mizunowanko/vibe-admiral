import { MockEngine } from "./mock-engine";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";

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

export default async function globalSetup() {
  const enginePort = await getRandomPort();
  const vitePort = await getRandomPort();

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
