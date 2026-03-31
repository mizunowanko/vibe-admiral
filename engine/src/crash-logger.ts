import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAdmiralHome } from "./admiral-home.js";

const LOGS_DIR = join(getAdmiralHome(), "logs");
const CRASH_LOG_FILE = join(LOGS_DIR, "engine-crash.log");

export type CrashContext =
  | "uncaughtException"
  | "unhandledRejection"
  | "supervisor:uncaughtException"
  | "supervisor:unhandledRejection"
  | "ws-child:uncaughtException"
  | "ws-child:unhandledRejection";

export interface CrashLog {
  timestamp: string;
  context: CrashContext;
  message: string;
  stack: string | undefined;
}

/**
 * Synchronously write crash information to disk.
 * Must be sync because process.exit(1) follows immediately.
 */
export function writeCrashLog(error: unknown, context: CrashContext): void {
  try {
    mkdirSync(LOGS_DIR, { recursive: true });

    const entry: CrashLog = {
      timestamp: new Date().toISOString(),
      context,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    };

    writeFileSync(CRASH_LOG_FILE, JSON.stringify(entry, null, 2), "utf-8");
  } catch {
    // If we can't write the crash log, there's nothing we can do —
    // don't let crash-logger itself prevent the process from exiting.
  }
}

/**
 * Read the last crash log if it exists. Returns null if no crash log found.
 */
export function readLastCrashLog(): CrashLog | null {
  try {
    const content = readFileSync(CRASH_LOG_FILE, "utf-8");
    return JSON.parse(content) as CrashLog;
  } catch {
    return null;
  }
}

/**
 * Remove the crash log file after it has been reported.
 */
export function clearCrashLog(): void {
  try {
    unlinkSync(CRASH_LOG_FILE);
  } catch {
    // File may not exist — that's fine.
  }
}
