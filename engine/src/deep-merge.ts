import type { SettingsLayer, CustomInstructions } from "./types.js";

/**
 * Merge two CustomInstructions objects.
 * Each field is concatenated (global + per-fleet) with newline separator.
 * If only one side has a value, that value is used as-is.
 */
function mergeCustomInstructions(
  global: CustomInstructions | undefined,
  perFleet: CustomInstructions | undefined,
): CustomInstructions | undefined {
  if (!global && !perFleet) return undefined;
  if (!global) return perFleet;
  if (!perFleet) return global;

  const keys = ["shared", "dock", "flagship", "ship", "escort"] as const;
  const result: CustomInstructions = {};
  for (const key of keys) {
    const g = global[key];
    const f = perFleet[key];
    if (g && f) {
      result[key] = `${g}\n\n${f}`;
    } else if (g || f) {
      result[key] = g ?? f;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Merge two string arrays with deduplication.
 * Global entries come first, per-fleet entries are appended (skipping duplicates).
 */
function mergeStringArrays(
  global: string[] | undefined,
  perFleet: string[] | undefined,
): string[] | undefined {
  if (!global?.length && !perFleet?.length) return undefined;
  if (!global?.length) return perFleet;
  if (!perFleet?.length) return global;
  const set = new Set(global);
  const result = [...global];
  for (const item of perFleet) {
    if (!set.has(item)) {
      result.push(item);
      set.add(item);
    }
  }
  return result;
}

/**
 * Deep-merge Admiral Global settings with Fleet Per-Fleet settings.
 *
 * Merge rules:
 * - customInstructions: each field concatenated (global + per-fleet, newline separator)
 * - gatePrompts: Object.assign (per-fleet wins per key)
 * - gates: Object.assign (per-fleet wins per key)
 * - qaRequiredPaths: array concat + dedupe
 * - acceptanceTestRequired: per-fleet wins if defined, otherwise global
 * - maxConcurrentSorties: per-fleet wins if defined, otherwise global
 */
export function mergeSettings(
  global: SettingsLayer | undefined,
  perFleet: SettingsLayer | undefined,
): SettingsLayer {
  if (!global) return perFleet ?? {};
  if (!perFleet) return global;

  return {
    customInstructions: mergeCustomInstructions(global.customInstructions, perFleet.customInstructions),
    gates: (global.gates || perFleet.gates)
      ? { ...global.gates, ...perFleet.gates }
      : undefined,
    gatePrompts: (global.gatePrompts || perFleet.gatePrompts)
      ? { ...global.gatePrompts, ...perFleet.gatePrompts }
      : undefined,
    qaRequiredPaths: mergeStringArrays(global.qaRequiredPaths, perFleet.qaRequiredPaths),
    acceptanceTestRequired: perFleet.acceptanceTestRequired ?? global.acceptanceTestRequired,
    maxConcurrentSorties: perFleet.maxConcurrentSorties ?? global.maxConcurrentSorties,
  };
}

/**
 * Apply Admiral template settings to a new fleet.
 * Returns a SettingsLayer to be spread into the new Fleet object.
 */
export function applyTemplate(template: SettingsLayer | undefined): SettingsLayer {
  if (!template) return {};
  // Deep copy to prevent mutations to the template
  return JSON.parse(JSON.stringify(template));
}
