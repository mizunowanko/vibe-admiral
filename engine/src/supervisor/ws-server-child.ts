/**
 * WS/API Server child process — entry point when running under Supervisor.
 *
 * Creates an EngineServer with an IpcProcessManager that proxies all
 * ProcessManager calls to the ProcessManager Worker via IPC (through Supervisor).
 */
import { EventEmitter } from "node:events";
import { EngineServer } from "../ws-server.js";
import { IpcProcessManager, type IpcChannel } from "./ipc-process-manager.js";
import { writeCrashLog } from "../crash-logger.js";
import type { IpcEvent, SupervisorToChild, ChildToSupervisor } from "./ipc-types.js";

const PORT = parseInt(process.env.ENGINE_PORT ?? "9721", 10);

// ── IPC Channel: wraps process IPC for communication with PM worker via Supervisor ──

const ipcEmitter = new EventEmitter();
const ipcChannel: IpcChannel = {
  send(msg: unknown) {
    try {
      process.send!(msg);
    } catch (err) {
      console.error("[ws-child] IPC send failed:", err);
    }
  },
  on(event: string, listener: (...args: unknown[]) => void) {
    ipcEmitter.on(event, listener);
  },
  removeAllListeners(event?: string) {
    ipcEmitter.removeAllListeners(event);
  },
};

const ipcProcessManager = new IpcProcessManager(ipcChannel);

// ── Start EngineServer ──

let engine: EngineServer;

try {
  engine = new EngineServer(PORT, ipcProcessManager);
} catch (err) {
  console.error("[ws-child] Failed to start EngineServer:", err);
  process.exit(1);
}

// ── Handle IPC messages from Supervisor ──

process.on("message", (msg: IpcEvent | SupervisorToChild) => {
  if ((msg as SupervisorToChild).type === "supervisor:shutdown") {
    console.log("[ws-child] Received shutdown signal");
    engine.shutdown();
    process.exit(0);
  }

  // Forward PM events to IpcProcessManager via the emitter
  ipcEmitter.emit("message", msg);
});

// ── Global error handlers ──

process.on("uncaughtException", (err) => {
  console.error("[ws-child] Uncaught exception:", err);
  writeCrashLog(err, "ws-child:uncaughtException");
  engine.shutdown();
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[ws-child] Unhandled rejection:", reason);
  writeCrashLog(reason, "ws-child:unhandledRejection");
  engine.shutdown();
  process.exit(1);
});

// ── Notify Supervisor we're ready ──

try {
  process.send!({ type: "child:ready" } satisfies ChildToSupervisor);
} catch {
  process.exit(1);
}

console.log(`[ws-child] EngineServer started on port ${PORT}`);
