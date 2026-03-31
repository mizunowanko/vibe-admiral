/**
 * ProcessManager Worker — child process entry point.
 *
 * Runs the real ProcessManager and bridges its events to the WS/API Server
 * via Node.js fork() IPC. Receives commands from WS/API Server and forwards
 * them to the ProcessManager.
 *
 * This process isolation ensures that Claude CLI stdout/stderr parsing errors
 * cannot crash the WS/API server (#632, #690).
 */
import { ProcessManager } from "../process-manager.js";
import type {
  IpcEvent,
  ProcessManagerWorkerMessage,
  ChildToSupervisor,
} from "./ipc-types.js";

const pm = new ProcessManager();

/** Track running processes for state dump on WS child restart. */
const runningProcesses = new Map<string, number | undefined>();

// ── Forward ProcessManager events → IPC ──

pm.on("spawn", (id: string) => {
  const pid = pm.getPid(id);
  runningProcesses.set(id, pid);
  sendIpc({ type: "spawn", id, pid });
});

pm.on("data", (id: string, message: Record<string, unknown>) => {
  sendIpc({ type: "data", id, message });
});

pm.on("exit", (id: string, code: number | null) => {
  runningProcesses.delete(id);
  sendIpc({ type: "exit", id, code });
});

pm.on("error", (id: string, error: Error) => {
  sendIpc({ type: "error", id, errorMessage: error.message });
});

pm.on("rate-limit", (id: string) => {
  sendIpc({ type: "rate-limit", id });
});

// ── Handle incoming IPC commands ──

process.on("message", (msg: ProcessManagerWorkerMessage) => {
  switch (msg.type) {
    case "sortie":
      pm.sortie(msg.id, msg.worktreePath, msg.issueNumber, msg.extraPrompt, msg.skill, msg.extraEnv);
      break;

    case "dispatch-sortie":
      pm.dispatchSortie(msg.id, msg.cwd, msg.prompt, msg.dispatchType, msg.extraEnv);
      break;

    case "launch-commander":
      pm.launchCommander(msg.id, msg.fleetPath, msg.additionalDirs, msg.systemPrompt, msg.extraEnv);
      break;

    case "resume-commander":
      pm.resumeCommander(msg.id, msg.sessionId, msg.fleetPath, msg.additionalDirs, msg.systemPrompt, msg.extraEnv);
      break;

    case "resume-session":
      pm.resumeSession(msg.id, msg.sessionId, msg.message, msg.cwd, msg.extraEnv, msg.appendSystemPrompt, msg.logFileName);
      break;

    case "send-message": {
      const result = pm.sendMessage(msg.id, msg.message, msg.images);
      sendIpc({ type: "send-result", id: msg.id, success: result !== null });
      break;
    }

    case "send-tool-result": {
      const result = pm.sendToolResult(msg.id, msg.toolUseId, msg.result);
      sendIpc({ type: "send-result", id: msg.id, success: result !== null });
      break;
    }

    case "kill": {
      const success = pm.kill(msg.id);
      if (success) {
        runningProcesses.delete(msg.id);
      }
      sendIpc({ type: "kill-result", id: msg.id, success });
      break;
    }

    case "kill-all":
      pm.killAll();
      runningProcesses.clear();
      break;

    case "ping":
      sendIpc({ type: "pong" });
      break;

    case "request-state-dump":
      sendIpc({
        type: "state-dump",
        processes: Array.from(runningProcesses.entries()).map(([id, pid]) => ({ id, pid })),
      });
      break;

    case "supervisor:shutdown":
      console.log("[pm-worker] Received shutdown signal");
      pm.killAll();
      runningProcesses.clear();
      process.exit(0);
      break;
  }
});

// ── IPC send helper with error handling ──

function sendIpc(event: IpcEvent): void {
  try {
    process.send!(event);
  } catch (err) {
    // IPC channel may be closed if parent died — log and continue
    console.error("[pm-worker] IPC send failed:", err);
  }
}

// ── Signal readiness to Supervisor ──

try {
  process.send!({ type: "child:ready" } satisfies ChildToSupervisor);
} catch {
  // If we can't even send ready, parent is gone
  process.exit(1);
}

console.log("[pm-worker] ProcessManager worker started");
