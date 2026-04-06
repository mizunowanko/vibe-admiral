import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Root of the units/ directory — resolved from engine/src/ at import time. */
const UNITS_DIR = join(import.meta.dirname, "..", "..", "units");

/** In-memory cache: unitName → raw template string (before variable substitution). */
const templateCache = new Map<string, string>();

/**
 * Load a unit's prompt.md and substitute `{{varName}}` template variables.
 *
 * @param unitName - One of "flagship", "dock", "ship", "escort", "dispatch"
 * @param vars     - Key/value pairs to replace `{{key}}` placeholders
 * @returns The rendered prompt string
 */
export function loadUnitPrompt(
  unitName: string,
  vars: Record<string, string> = {},
): string {
  let template = templateCache.get(unitName);
  if (template === undefined) {
    const filePath = join(UNITS_DIR, unitName, "prompt.md");
    template = readFileSync(filePath, "utf-8");
    templateCache.set(unitName, template);
  }

  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

/**
 * Clear the template cache. Useful for testing or if prompt.md files
 * are modified at runtime (hot-reload scenario).
 */
export function clearPromptCache(): void {
  templateCache.clear();
}
