#!/usr/bin/env node
/**
 * Dev runner with restart support.
 *
 * Spawns `concurrently` to run Vite + Engine.
 * When Engine writes a `.restart` marker file and exits,
 * this runner restarts both processes automatically.
 */
import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RESTART_MARKER = join(ROOT, ".restart");

// Clean up any stale marker from a previous run
if (existsSync(RESTART_MARKER)) unlinkSync(RESTART_MARKER);

function start(env = {}) {
  const proc = spawn(
    "npx",
    ["concurrently", "--kill-others", "\"vite\"", "\"tsx watch engine/src/index.ts\""],
    {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, ...env },
      shell: true,
    },
  );

  proc.on("close", () => {
    if (existsSync(RESTART_MARKER)) {
      unlinkSync(RESTART_MARKER);
      console.log("\n[dev-runner] Restart requested — restarting all services...\n");
      // Small delay to allow ports to be released
      setTimeout(() => start({ RESTARTED: "1" }), 1000);
    }
    // Normal exit — do nothing (let the process end naturally)
  });
}

start();
