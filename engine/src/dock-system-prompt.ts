import { loadUnitPrompt } from "./prompt-loader.js";

/**
 * Build the system prompt for Dock (Issue management AI) sessions.
 *
 * Dock is responsible for Issue lifecycle management:
 * clarity assessment, triage, priority decisions,
 * /investigate, /issue-manage, /read-issue.
 *
 * Prompt content lives in units/dock/prompt.md.
 * Detailed rules live in:
 * - .claude/rules/commander-rules.md (shared Flagship/Dock rules)
 * - units/dock/skills/issue-manage/    (creation, triage, priority, dependency tracking)
 * - units/dock/skills/investigate/    (Dispatch templates)
 */
export function buildDockSystemPrompt(
  fleetName: string,
  repos: string[],
): string {
  return loadUnitPrompt("dock", {
    fleetName,
    repos: repos.join(", "),
  });
}
