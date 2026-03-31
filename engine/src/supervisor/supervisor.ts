/**
 * Supervisor — lightweight parent process that manages child processes.
 *
 * Forks two children:
 *   1. WS/API Server (ws-server-child.ts) — Frontend communication, XState, HTTP API
 *   2. ProcessManager Worker (process-manager-worker.ts) — Claude CLI spawn/kill/stdout
 *
 * Responsibilities:
 *   - Monitor child health and auto-restart on crash
 *   - Relay IPC messages between children (PM events → WS, WS commands → PM)
 *   - Graceful shutdown ordering (WS first, then PM)
 *
 * See ADR-0016 Phase 2 for the design rationale.
 */
import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { writeCrashLog } from "../crash-logger.js";
import type { Serializable } from "node:child_process";
import type { IpcEvent, SupervisorToChild, ChildToSupervisor, IpcRequestStateDump } from "./ipc-types.js";

const PORT = parseInt(process.env.ENGINE_PORT ?? "9721", 10);

/** Max restart delay in ms (exponential backoff cap). */
const MAX_RESTART_DELAY_MS = 30_000;

/** Base restart delay in ms. */
const BASE_RESTART_DELAY_MS = 1_000;

/** Minimum uptime before resetting backoff counter (ms). */
const STABLE_UPTIME_MS = 60_000;

interface ChildState {
  process: ChildProcess | null;
  restartCount: number;
  lastStartTime: number;
  shuttingDown: boolean;
}

// ── Child State ──

const pmState: ChildState = {
  process: null,
  restartCount: 0,
  lastStartTime: 0,
  shuttingDown: false,
};

const wsState: ChildState = {
  process: null,
  restartCount: 0,
  lastStartTime: 0,
  shuttingDown: false,
};

let isShuttingDown = false;
let isRestarting = false;

// ── Script paths (resolve relative to this file's location) ──

// In dev (tsx): import.meta.dirname points to engine/src/supervisor/
// In prod (tsup): import.meta.dirname points to dist/ (flat output)
// Worker scripts are resolved relative to this supervisor script.
const SCRIPT_DIR = import.meta.dirname;

function resolveWorkerPath(filename: string): string {
  return join(SCRIPT_DIR, filename);
}

// ── Fork helpers ──

function forkPmWorker(): ChildProcess {
  const child = fork(resolveWorkerPath("process-manager-worker.js"), [], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  pmState.process = child;
  pmState.lastStartTime = Date.now();

  child.on("message", (msg: Serializable) => {
    const typed = msg as IpcEvent | ChildToSupervisor;
    if (typed.type === "child:ready") {
      console.log("[supervisor] PM worker ready");
      return;
    }
    // Relay PM events to WS child
    if (wsState.process?.connected) {
      try {
        wsState.process.send(msg);
      } catch {
        // WS child may have died — events will be replayed via state-dump on restart
      }
    }
  });

  child.on("exit", (code, signal) => {
    console.warn(`[supervisor] PM worker exited (code=${code}, signal=${signal})`);
    pmState.process = null;
    if (!isShuttingDown && !pmState.shuttingDown) {
      scheduleRestart(pmState, forkPmWorker, "PM worker");
    }
  });

  child.on("error", (err) => {
    console.error("[supervisor] PM worker error:", err);
  });

  return child;
}

function forkWsChild(): ChildProcess {
  const child = fork(resolveWorkerPath("ws-server-child.js"), [], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    env: {
      ...process.env,
      ENGINE_PORT: String(PORT),
    },
  });
  wsState.process = child;
  wsState.lastStartTime = Date.now();

  child.on("message", (msg: Serializable) => {
    const typed = msg as { type: string };
    if (typed.type === "child:ready") {
      console.log("[supervisor] WS server ready");
      // After WS restart, request state dump from PM so IpcProcessManager rebuilds mirror
      if (pmState.process?.connected) {
        try {
          pmState.process.send({ type: "request-state-dump" } satisfies IpcRequestStateDump);
        } catch {
          // PM may not be ready yet
        }
      }
      return;
    }
    if (typed.type === "child:restart-request") {
      gracefulRestart();
      return;
    }
    // Relay WS commands to PM worker
    if (pmState.process?.connected) {
      try {
        pmState.process.send(msg);
      } catch {
        console.error("[supervisor] Failed to relay command to PM worker");
      }
    }
  });

  child.on("exit", (code, signal) => {
    console.warn(`[supervisor] WS server exited (code=${code}, signal=${signal})`);
    wsState.process = null;
    if (!isShuttingDown && !wsState.shuttingDown) {
      scheduleRestart(wsState, forkWsChild, "WS server");
    }
  });

  child.on("error", (err) => {
    console.error("[supervisor] WS server error:", err);
  });

  return child;
}

// ── Restart with exponential backoff ──

function scheduleRestart(
  state: ChildState,
  forkFn: () => ChildProcess,
  label: string,
): void {
  const uptime = Date.now() - state.lastStartTime;

  // Reset backoff if the child was stable long enough
  if (uptime >= STABLE_UPTIME_MS) {
    state.restartCount = 0;
  }

  const delay = Math.min(
    BASE_RESTART_DELAY_MS * Math.pow(2, state.restartCount),
    MAX_RESTART_DELAY_MS,
  );
  state.restartCount++;

  console.log(`[supervisor] Restarting ${label} in ${delay}ms (attempt #${state.restartCount})`);

  setTimeout(() => {
    if (isShuttingDown) return;
    console.log(`[supervisor] Forking ${label}...`);
    forkFn();
  }, delay);
}

// ── Graceful restart (prod-mode: WS child requests restart via IPC) ──

function gracefulRestart(): void {
  if (isRestarting || isShuttingDown) return;
  isRestarting = true;
  console.log("[supervisor] Graceful restart requested — shutting down children for restart");

  const shutdownMsg: SupervisorToChild = { type: "supervisor:shutdown" };

  let wsExited = false;
  let pmExited = false;

  const tryRefork = () => {
    if (!wsExited || !pmExited) return;
    console.log("[supervisor] All children exited — reforking with RESTARTED=1");
    process.env.RESTARTED = "1";
    isRestarting = false;
    wsState.restartCount = 0;
    pmState.restartCount = 0;
    wsState.shuttingDown = false;
    pmState.shuttingDown = false;
    forkPmWorker();
    forkWsChild();
  };

  // Track WS child exit
  if (wsState.process) {
    wsState.shuttingDown = true;
    const wsChild = wsState.process;
    wsChild.once("exit", () => { wsExited = true; tryRefork(); });
    try { wsChild.send(shutdownMsg); } catch { wsChild.kill("SIGTERM"); }
  } else {
    wsExited = true;
  }

  // Shut down PM worker after WS (2s delay)
  setTimeout(() => {
    if (pmState.process) {
      pmState.shuttingDown = true;
      const pmChild = pmState.process;
      pmChild.once("exit", () => { pmExited = true; tryRefork(); });
      try { pmChild.send(shutdownMsg); } catch { pmChild.kill("SIGTERM"); }
    } else {
      pmExited = true;
      tryRefork();
    }

    // Force refork after timeout
    setTimeout(() => {
      if (!wsExited || !pmExited) {
        console.warn("[supervisor] Force killing remaining children for restart");
        if (!wsExited && wsState.process) wsState.process.kill("SIGKILL");
        if (!pmExited && pmState.process) pmState.process.kill("SIGKILL");
        wsExited = true;
        pmExited = true;
        tryRefork();
      }
    }, 5_000);
  }, 2_000);
}

// ── Graceful shutdown (WS first, then PM) ──

function shutdown(signal: string): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[supervisor] ${signal} received — shutting down children`);

  const shutdownMsg: SupervisorToChild = { type: "supervisor:shutdown" };

  // 1. Shut down WS server first
  if (wsState.process?.connected) {
    wsState.shuttingDown = true;
    try {
      wsState.process.send(shutdownMsg);
    } catch {
      wsState.process.kill("SIGTERM");
    }
  }

  // 2. Then shut down PM worker (allow CLI processes to be cleaned up)
  setTimeout(() => {
    if (pmState.process?.connected) {
      pmState.shuttingDown = true;
      try {
        pmState.process.send(shutdownMsg);
      } catch {
        pmState.process.kill("SIGTERM");
      }
    }

    // 3. Force exit after timeout
    setTimeout(() => {
      console.log("[supervisor] Force exit");
      process.exit(0);
    }, 5_000);
  }, 2_000);
}

// ── Global error handlers ──

process.on("uncaughtException", (err) => {
  console.error("[supervisor] Uncaught exception:", err);
  writeCrashLog(err, "supervisor:uncaughtException");
  shutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  console.error("[supervisor] Unhandled rejection:", reason);
  writeCrashLog(reason, "supervisor:unhandledRejection");
  shutdown("unhandledRejection");
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ── Start ──

console.log(`[supervisor] Starting vibe-admiral engine (port ${PORT})`);

// Fork PM worker first (WS server needs it for IpcProcessManager)
forkPmWorker();

// Fork WS/API server
forkWsChild();

console.log("[supervisor] Children forked");
