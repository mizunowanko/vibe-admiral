import type { Phase } from "@/types";

export interface StatusConfig {
  color: string;
  textColor: string;
  animate?: boolean;
}

export const STATUS_CONFIG: Record<Phase, StatusConfig> = {
  plan: { color: "bg-indigo-500/20 text-indigo-400", textColor: "text-indigo-400", animate: true },
  "plan-gate": { color: "bg-sky-500/20 text-sky-400", textColor: "text-sky-400" },
  coding: { color: "bg-violet-500/20 text-violet-400", textColor: "text-violet-400", animate: true },
  "coding-gate": { color: "bg-sky-500/20 text-sky-400", textColor: "text-sky-400" },
  qa: { color: "bg-amber-500/20 text-amber-400", textColor: "text-amber-400", animate: true },
  "qa-gate": { color: "bg-sky-500/20 text-sky-400", textColor: "text-sky-400" },
  merging: { color: "bg-emerald-500/20 text-emerald-400", textColor: "text-emerald-400", animate: true },
  done: { color: "bg-green-500/20 text-green-400", textColor: "text-green-400" },
  stopped: { color: "bg-gray-500/20 text-gray-400", textColor: "text-gray-400" },
};

/** Config for the derived "process dead" state (not a real phase). */
export const PROCESS_DEAD_CONFIG: StatusConfig = {
  color: "bg-red-500/20 text-red-400",
  textColor: "text-red-400",
};

/** Convert a phase name to display text (capitalize first letter of each segment).
 *  e.g., "plan" → "Plan", "plan-gate" → "Plan (Review)", "qa" → "QA" */
export function phaseDisplayName(phase: Phase | string): string {
  if (phase === "qa" || phase === "QA") return "QA";
  if (phase.endsWith("-gate")) {
    const base = phase.slice(0, -5);
    return `${phaseDisplayName(base)} (Review)`;
  }
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

export function getStatusColor(content: string): string {
  if (content.includes("compacting")) return "text-purple-400";
  for (const [status, config] of Object.entries(STATUS_CONFIG)) {
    if (content.includes(`: ${status}`)) return config.textColor;
  }
  return "text-muted-foreground";
}
