import { EngineServer } from "./ws-server.js";

const PORT = parseInt(process.env.VIBE_ADMIRAL_PORT ?? "9721", 10);

const engine = new EngineServer(PORT);

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
