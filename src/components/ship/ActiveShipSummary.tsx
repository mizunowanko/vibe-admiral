import { memo, useMemo, useRef } from "react";
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

function buildSummaryFingerprint(ships: Ship[]): string {
  return ships
    .map((s) => `${s.id}:${s.phase}:${s.issueNumber}:${s.processDead ?? false}`)
    .join("|");
}

export const ActiveShipSummary = memo(function ActiveShipSummary({ fleetId }: ActiveShipSummaryProps) {
  const setViewingShipId = useUIStore((s) => s.setViewingShipId);

  // Use fingerprint-based selector to avoid re-renders on unrelated ship store changes (e.g. log additions)
  const prevRef = useRef<{ fingerprint: string; ships: Ship[] }>({ fingerprint: "", ships: [] });
  const fleetShips = useShipStore((s) => {
    const filtered = Array.from(s.ships.values()).filter((ship) => ship.fleetId === fleetId);
    const fingerprint = buildSummaryFingerprint(filtered);
    if (fingerprint === prevRef.current.fingerprint) {
      return prevRef.current.ships;
    }
    prevRef.current = { fingerprint, ships: filtered };
    return filtered;
  });

  const activeShips = useMemo(() => {
    return fleetShips.filter(
      (s) =>
        s.phase !== "done" &&
        s.phase !== "stopped" &&
        !s.processDead,
    );
  }, [fleetShips]);

  const errorShips = useMemo(() => {
    return fleetShips.filter(
      (s) =>
        s.processDead &&
        s.phase !== "done" &&
        s.phase !== "stopped",
    );
  }, [fleetShips]);

  const phaseCounts = useMemo(() => {
    const counts = new Map<Phase, Ship[]>();
    for (const ship of activeShips) {
      const list = counts.get(ship.phase) ?? [];
      list.push(ship);
      counts.set(ship.phase, list);
    }
    return counts;
  }, [activeShips]);

  if (activeShips.length === 0 && errorShips.length === 0) return null;

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
        {errorShips.map((ship) => (
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
});
