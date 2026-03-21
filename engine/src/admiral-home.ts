import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Return the Admiral state directory.
 *
 * Priority:
 *   1. ADMIRAL_HOME env var (explicit override)
 *   2. ~/.vibe-admiral/ (default)
 */
export function getAdmiralHome(): string {
  return process.env.ADMIRAL_HOME ?? join(homedir(), ".vibe-admiral");
}
