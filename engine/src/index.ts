/**
 * Engine entry point — launches the Supervisor process.
 *
 * The Supervisor forks two child processes:
 *   1. WS/API Server (frontend communication, XState, HTTP API)
 *   2. ProcessManager Worker (Claude CLI spawn/kill/stdout parsing)
 *
 * This process isolation ensures that a crash in one child doesn't
 * take down the other. See ADR-0016 Phase 2 for design rationale.
 *
 * For standalone mode (no process isolation), set ENGINE_NO_SUPERVISOR=1.
 */
export {};

const noSupervisor = process.env.ENGINE_NO_SUPERVISOR === "1";

if (noSupervisor) {
  // Standalone mode: run EngineServer directly (backward compatible, useful for testing)
  const { EngineServer } = await import("./ws-server.js");
  const { writeCrashLog } = await import("./crash-logger.js");

  const PORT = parseInt(process.env.ENGINE_PORT ?? "9721", 10);

  let engine: InstanceType<typeof EngineServer>;

  try {
    engine = new EngineServer(PORT);
  } catch (err) {
    console.error("[engine] Failed to start:", err);
    process.exit(1);
  }

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

  console.log(`vibe-admiral engine started on port ${PORT} (standalone mode)`);
} else {
  // Supervisor mode: import and run the supervisor (default)
  await import("./supervisor/supervisor.js");
}
