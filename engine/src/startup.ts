/**
 * Engine startup sequence: database initialization and reconciliation.
 * Extracted from ws-server.ts (ADR-0016 Phase 1).
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ShipManager } from "./ship-manager.js";
import type { StateSync } from "./state-sync.js";
import type { CaffeinateManager } from "./caffeinate-manager.js";
import { initFleetDatabase } from "./db.js";
import type { FleetDatabase } from "./db.js";
import { getAdmiralHome } from "./admiral-home.js";
import type { Fleet, AdmiralSettings } from "./types.js";

export interface StartupDeps {
  shipManager: ShipManager;
  stateSync: StateSync;
  caffeinateManager: CaffeinateManager;
  setFleetDb(db: FleetDatabase): void;
  getFleetDb(): FleetDatabase | null;
  loadAdmiralSettings(): Promise<AdmiralSettings>;
  loadFleets(): Promise<Fleet[]>;
  shutdown(): void;
}

export function runStartupReconciliation(deps: StartupDeps): void {
  initDatabase(deps)
    .then(async () => {
      const settings = await deps.loadAdmiralSettings();
      deps.caffeinateManager.setEnabled(settings.caffeinateEnabled !== false);
    })
    .then(() => deps.loadFleets())
    .then((fleets) => {
      const allRepos = fleets.flatMap((f) => f.repos);
      return deps.stateSync.reconcileOnStartup(allRepos);
    })
    .catch((err) => {
      if (!deps.getFleetDb()) {
        // DB init failed — fatal, Engine cannot operate without a database
        console.error("[engine] Database initialization failed, shutting down:", err);
        deps.shutdown();
        process.exit(1);
      }
      // Non-DB errors (fleet loading, reconciliation) are non-fatal
      console.warn("[engine] Startup reconciliation failed:", err);
    });
}

async function initDatabase(deps: StartupDeps): Promise<void> {
  try {
    const admiralHome = getAdmiralHome();
    const dbPath = join(admiralHome, "fleet.db");
    console.log(`[engine] Opening fleet database at: ${dbPath}`);

    const db = await initFleetDatabase(admiralHome);
    deps.setFleetDb(db);
    deps.shipManager.setDatabase(db);

    // Verify DB path consistency: warn if ADMIRAL_HOME changed since last run
    await checkDbPathConsistency(admiralHome);

    console.log("[engine] Fleet database initialized");
  } catch (err) {
    console.error("[engine] Failed to initialize fleet database:", err);
    throw err;
  }
}

/**
 * Check if the DB path matches the one used in the previous run.
 * Warns if ADMIRAL_HOME changed, which would create a new empty DB.
 */
async function checkDbPathConsistency(currentHome: string): Promise<void> {
  const markerPath = join(currentHome, ".db-home-marker");
  try {
    const previousHome = await readFile(markerPath, "utf-8").catch(() => null);
    if (previousHome !== null && previousHome.trim() !== currentHome) {
      console.warn(
        `[engine] WARNING: ADMIRAL_HOME changed from "${previousHome.trim()}" to "${currentHome}". ` +
        `Ship data from the previous path may be inaccessible.`,
      );
    }
    await writeFile(markerPath, currentHome, "utf-8");
  } catch (err) {
    // Non-fatal: best-effort consistency tracking
    console.warn("[engine] Could not check DB path consistency:", err);
  }
}
