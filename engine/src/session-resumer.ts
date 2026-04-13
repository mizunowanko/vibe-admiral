/**
 * SessionResumer — unified cwd/session validation for all resume paths (ADR-0024).
 *
 * Consolidates the cwd/session validation logic from:
 * - commander.ts launch() (lines 70-73)
 * - commander.ts resumeIfDead()
 * - process-manager.ts resumeCommander()
 *
 * All three paths now go through validateOrFresh() for consistent behavior.
 */
import type { AbsolutePath, ClaudeSessionId } from "./context-registry.js";

export type ResumeDecision = "resume" | "fresh";

export interface ResumeValidationResult {
  decision: ResumeDecision;
  sessionId: ClaudeSessionId | null;
  reason: string;
}

/**
 * Validate whether a session can be safely resumed, or if a fresh start is needed.
 *
 * Rules:
 * 1. No sessionId → always fresh
 * 2. No persisted cwd → allow resume (backward compat for sessions created before cwd tracking)
 * 3. cwd changed → fresh (old session context is invalid for new working directory)
 * 4. cwd matches → resume
 */
export function validateOrFresh(
  sessionId: ClaudeSessionId | null,
  opts: {
    expectedCwd: AbsolutePath;
    persistedCwd?: AbsolutePath;
  },
): ResumeValidationResult {
  if (!sessionId) {
    return { decision: "fresh", sessionId: null, reason: "no session ID" };
  }

  if (!opts.persistedCwd) {
    return { decision: "resume", sessionId, reason: "no persisted cwd (backward compat)" };
  }

  if (opts.persistedCwd !== opts.expectedCwd) {
    console.log(
      `[session-resumer] cwd changed: ${opts.persistedCwd} → ${opts.expectedCwd} — forcing fresh start`,
    );
    return {
      decision: "fresh",
      sessionId: null,
      reason: `cwd changed from ${opts.persistedCwd} to ${opts.expectedCwd}`,
    };
  }

  return { decision: "resume", sessionId, reason: "cwd matches" };
}
