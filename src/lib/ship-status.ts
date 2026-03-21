import type { Phase } from "@/types";

export interface StatusConfig {
  label: string;
  color: string;
  textColor: string;
  animate?: boolean;
}

export const STATUS_CONFIG: Record<Phase, StatusConfig> = {
  planning: { label: "Planning", color: "bg-indigo-500/20 text-indigo-400", textColor: "text-indigo-400", animate: true },
  "planning-gate": { label: "Plan Gate", color: "bg-sky-500/20 text-sky-400", textColor: "text-sky-400" },
  implementing: { label: "Implementing", color: "bg-violet-500/20 text-violet-400", textColor: "text-violet-400", animate: true },
  "implementing-gate": { label: "Code Gate", color: "bg-sky-500/20 text-sky-400", textColor: "text-sky-400" },
  "acceptance-test": { label: "Acceptance Test", color: "bg-amber-500/20 text-amber-400", textColor: "text-amber-400", animate: true },
  "acceptance-test-gate": { label: "QA Gate", color: "bg-sky-500/20 text-sky-400", textColor: "text-sky-400" },
  merging: { label: "Merging", color: "bg-emerald-500/20 text-emerald-400", textColor: "text-emerald-400", animate: true },
  done: { label: "Done", color: "bg-green-500/20 text-green-400", textColor: "text-green-400" },
};

/** Config for the derived "process dead" state (not a real phase). */
export const PROCESS_DEAD_CONFIG: StatusConfig = {
  label: "Error",
  color: "bg-red-500/20 text-red-400",
  textColor: "text-red-400",
};

export function getStatusColor(content: string): string {
  if (content.includes("compacting")) return "text-purple-400";
  for (const [status, config] of Object.entries(STATUS_CONFIG)) {
    if (content.includes(`: ${status}`)) return config.textColor;
  }
  return "text-muted-foreground";
}
