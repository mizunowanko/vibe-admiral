import { useMemo } from "react";
import { useShipStore } from "@/stores/shipStore";
import { useUIStore } from "@/stores/uiStore";
import { cn } from "@/lib/utils";
import { STATUS_CONFIG, PROCESS_DEAD_CONFIG } from "@/lib/ship-status";
import type { Ship, Phase } from "@/types";

interface ActiveShipSummaryProps {
  fleetId: string;
}

const PHASE_ORDER: Phase[] = [
  "planning",
  "planning-gate",
  "implementing",
  "implementing-gate",
  "acceptance-test",
  "acceptance-test-gate",
  "merging",
];

export function ActiveShipSummary({ fleetId }: ActiveShipSummaryProps) {
  const ships = useShipStore((s) => s.ships);
  const setViewingShipId = useUIStore((s) => s.setViewingShipId);

  const activeShips = useMemo(() => {
    return Array.from(ships.values()).filter(
      (s) =>
        s.fleetId === fleetId &&
        s.phase !== "done" &&
        s.phase !== "stopped" &&
        !s.processDead,
    );
  }, [ships, fleetId]);

  const phaseCounts = useMemo(() => {
    const counts = new Map<Phase, Ship[]>();
    for (const ship of activeShips) {
      const list = counts.get(ship.phase) ?? [];
      list.push(ship);
      counts.set(ship.phase, list);
    }
    return counts;
  }, [activeShips]);

  if (activeShips.length === 0) return null;

  return (
    <div className="border-b border-border px-3 py-2 bg-card/50">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider shrink-0">
          Active: {activeShips.length}
        </span>
        {PHASE_ORDER.map((phase) => {
          const shipsInPhase = phaseCounts.get(phase);
          if (!shipsInPhase || shipsInPhase.length === 0) return null;
          const config = STATUS_CONFIG[phase];
          return (
            <div key={phase} className="flex items-center gap-1">
              {shipsInPhase.map((ship) => (
                <button
                  key={ship.id}
                  onClick={() => setViewingShipId(ship.id)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] transition-colors",
                    "hover:ring-1 hover:ring-primary/50 cursor-pointer",
                    config.color,
                  )}
                  title={`#${ship.issueNumber}: ${ship.issueTitle}`}
                >
                  {config.animate && (
                    <span className="inline-block h-1 w-1 rounded-full bg-current animate-pulse" />
                  )}
                  #{ship.issueNumber}
                </button>
              ))}
            </div>
          );
        })}
        {/* Error ships */}
        {Array.from(ships.values())
          .filter(
            (s) =>
              s.fleetId === fleetId &&
              s.processDead &&
              s.phase !== "done" &&
              s.phase !== "stopped",
          )
          .map((ship) => (
            <button
              key={ship.id}
              onClick={() => setViewingShipId(ship.id)}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] transition-colors",
                "hover:ring-1 hover:ring-primary/50 cursor-pointer",
                PROCESS_DEAD_CONFIG.color,
              )}
              title={`#${ship.issueNumber}: ${ship.issueTitle} (Error)`}
            >
              #{ship.issueNumber}
            </button>
          ))}
      </div>
    </div>
  );
}
