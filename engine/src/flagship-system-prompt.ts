import { loadUnitPrompt } from "./prompt-loader.js";

/**
 * Build the system prompt for Flagship (Ship management AI) sessions.
 *
 * Flagship is responsible for Ship lifecycle management:
 * sortie, ship-status, ship-pause, ship-resume, ship-abandon, ship-reactivate, /hotfix,
 * Lookout alerts, and Gate monitoring.
 *
 * Prompt content lives in units/flagship/prompt.md.
 * Detailed rules live in:
 * - .claude/rules/commander-rules.md (shared Flagship/Dock rules)
 * - units/shared/skills/admiral-protocol/  (API reference + ship-status rules)
 * - units/flagship/skills/sortie/         (clarity check + critical escalation)
 * - units/flagship/skills/ship-inspect/   (Ship log reading + Dispatch templates)
 */
export function buildFlagshipSystemPrompt(
  fleetName: string,
  repos: string[],
  maxConcurrentSorties: number = 6,
): string {
  return loadUnitPrompt("flagship", {
    fleetName,
    repos: repos.join(", "),
    maxSorties: String(maxConcurrentSorties),
  });
}
