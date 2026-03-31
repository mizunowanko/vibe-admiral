import { memo, useMemo, useRef } from "react";
import { useShipStore } from "@/stores/shipStore";
import { useSessionStore, shipSessionId } from "@/stores/sessionStore";
import { cn } from "@/lib/utils";
import { STATUS_CONFIG } from "@/lib/ship-status";
import { PHASE_ORDER } from "@/types";
import type { Ship, Phase } from "@/types";

interface ActiveShipSummaryProps {
  fleetId: string;
}

function buildSummaryFingerprint(ships: Ship[]): string {
  return ships
    .map((s) => `${s.id}:${s.phase}:${s.issueNumber}:${s.processDead ?? false}`)
    .join("|");
}

export const ActiveShipSummary = memo(function ActiveShipSummary({ fleetId }: ActiveShipSummaryProps) {
  const setFocus = useSessionStore((s) => s.setFocus);

  const prevRef = useRef<{ fingerprint: string; ships: Ship[] }>({ fingerprint: "", ships: [] });
  const fleetShips = useShipStore((s) => {
    const filtered = Array.from(s.ships.values()).filter(
      (ship) => ship.fleetId === fleetId,
    );
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
        s.phase !== "paused" &&
        s.phase !== "abandoned" &&
        !s.processDead,
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

  if (activeShips.length === 0) return null;

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {PHASE_ORDER.map((phase) => {
        const shipsInPhase = phaseCounts.get(phase);
        if (!shipsInPhase || shipsInPhase.length === 0) return null;
        const config = STATUS_CONFIG[phase];
        return (
          <div key={phase} className="flex items-center gap-0.5">
            {shipsInPhase.map((ship) => (
              <button
                key={ship.id}
                onClick={() => setFocus(shipSessionId(ship.id), "user-click")}
                className={cn(
                  "inline-flex items-center gap-0.5 rounded-md px-1 py-0 text-[10px] transition-colors",
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
    </div>
  );
});
