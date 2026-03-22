import net from "node:net";

/**
 * Get a random available port by binding to port 0 (OS auto-assigns).
 * If `envVar` is set in the environment, its value is used instead.
 */
export async function getAvailablePort(envVar?: string): Promise<number> {
  if (envVar) {
    const fromEnv = process.env[envVar];
    if (fromEnv) return parseInt(fromEnv, 10);
  }

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

/**
 * Wait for a port to accept TCP connections (polling with retry).
 */
export function waitForPort(
  port: number,
  timeoutMs = 30_000,
): Promise<void> {
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

/**
 * Gracefully kill a child process: SIGTERM first, then SIGKILL after timeout.
 */
export function killProcess(
  proc: { killed: boolean; kill: (signal: string) => boolean; on: (event: string, cb: () => void) => void },
  timeoutMs = 5000,
): Promise<void> {
  if (!proc || proc.killed) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    proc.on("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    proc.kill("SIGTERM");
  });
}
