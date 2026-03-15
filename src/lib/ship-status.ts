import type { ShipStatus } from "@/types";

export interface StatusConfig {
  label: string;
  color: string;
  textColor: string;
  animate?: boolean;
}

export const STATUS_CONFIG: Record<ShipStatus, StatusConfig> = {
  sortie: { label: "Sortie", color: "bg-yellow-500/20 text-yellow-400", textColor: "text-yellow-400", animate: true },
  investigating: { label: "Investigating", color: "bg-blue-500/20 text-blue-400", textColor: "text-blue-400", animate: true },
  planning: { label: "Planning", color: "bg-indigo-500/20 text-indigo-400", textColor: "text-indigo-400", animate: true },
  implementing: { label: "Implementing", color: "bg-violet-500/20 text-violet-400", textColor: "text-violet-400", animate: true },
  testing: { label: "Testing", color: "bg-cyan-500/20 text-cyan-400", textColor: "text-cyan-400", animate: true },
  reviewing: { label: "Reviewing", color: "bg-orange-500/20 text-orange-400", textColor: "text-orange-400", animate: true },
  "acceptance-test": { label: "Acceptance Test", color: "bg-amber-500/20 text-amber-400", textColor: "text-amber-400" },
  merging: { label: "Merging", color: "bg-emerald-500/20 text-emerald-400", textColor: "text-emerald-400", animate: true },
  done: { label: "Done", color: "bg-green-500/20 text-green-400", textColor: "text-green-400" },
  error: { label: "Error", color: "bg-red-500/20 text-red-400", textColor: "text-red-400" },
};

export function getStatusColor(content: string): string {
  if (content.includes("compacting")) return "text-purple-400";
  for (const [status, config] of Object.entries(STATUS_CONFIG)) {
    if (content.includes(`: ${status}`)) return config.textColor;
  }
  return "text-muted-foreground";
}
