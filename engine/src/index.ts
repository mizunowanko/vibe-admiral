import { EngineServer } from "./ws-server.js";
import { writeCrashLog } from "./crash-logger.js";

const PORT = parseInt(process.env.ENGINE_PORT ?? "9721", 10);

let engine: EngineServer;

try {
  engine = new EngineServer(PORT);
} catch (err) {
  console.error("[engine] Failed to start:", err);
  process.exit(1);
}

// Global error handlers — prevent silent crashes
process.on("uncaughtException", (err) => {
  console.error("[engine] Uncaught exception:", err);
  writeCrashLog(err, "uncaughtException");
  engine.shutdown();
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[engine] Unhandled rejection:", reason);
  writeCrashLog(reason, "unhandledRejection");
  engine.shutdown();
  process.exit(1);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down engine...");
  engine.shutdown();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\nShutting down engine...");
  engine.shutdown();
  process.exit(0);
});

console.log(`vibe-admiral engine started on port ${PORT}`);
