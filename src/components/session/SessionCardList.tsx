import { memo, useState, useMemo, useRef } from "react";
import { useSessionStore, commanderSessionId, shipSessionId } from "@/stores/sessionStore";
import { useShipStore } from "@/stores/shipStore";
import { ActiveShipSummary } from "@/components/ship/ActiveShipSummary";
import { SessionCard, DispatchCard } from "./SessionCard";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Ship, Dispatch } from "@/types";

interface SessionCardListProps {
  fleetId: string;
}

function buildFleetShipFingerprint(ships: Ship[]): string {
  return ships
    .map(
      (s) =>
        `${s.id}:${s.phase}:${s.issueNumber}:${s.issueTitle}:${s.isCompacting}:${s.gateCheck?.status ?? ""}:${s.processDead ?? false}:${s.repo}`,
    )
    .join("|");
}

function ShipsSection({ fleetId }: { fleetId: string }) {
  const focusedSessionId = useSessionStore((s) => s.focusedSessionId);
  const setFocus = useSessionStore((s) => s.setFocus);
  const sessions = useSessionStore((s) => s.sessions);
  const [showInactive, setShowInactive] = useState(false);

  const prevRef = useRef<{ fingerprint: string; ships: Ship[] }>({
    fingerprint: "",
    ships: [],
  });
  const allFleetShips = useShipStore((s) => {
    const filtered = Array.from(s.ships.values()).filter(
      (ship) => ship.fleetId === fleetId,
    );
    const fingerprint = buildFleetShipFingerprint(filtered);
    if (fingerprint === prevRef.current.fingerprint) {
      return prevRef.current.ships;
    }
    prevRef.current = { fingerprint, ships: filtered };
    return filtered;
  });

  const fleetShips = useMemo(
    () =>
      showInactive
        ? allFleetShips
        : allFleetShips.filter(
            (s) =>
              s.phase !== "done" &&
              s.phase !== "stopped" &&
              !s.processDead,
          ),
    [allFleetShips, showInactive],
  );

  return (
    <div className="px-3 py-2">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <h3 className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Ships
          </h3>
          <ActiveShipSummary fleetId={fleetId} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">
            {fleetShips.length} ship{fleetShips.length !== 1 ? "s" : ""}
          </span>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="h-3 w-3 rounded border-border accent-primary"
            />
            <span className="text-[10px] text-muted-foreground">
              Show inactive
            </span>
          </label>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2">
        {fleetShips.length === 0 && (
          <p className="text-center text-xs text-muted-foreground py-4">
            No active ships
          </p>
        )}
        {fleetShips.map((ship) => {
          const sessionId = shipSessionId(ship.id);
          const session = sessions.get(sessionId);
          if (!session) return null;
          return (
            <SessionCard
              key={ship.id}
              session={session}
              ship={ship}
              isFocused={focusedSessionId === sessionId}
              onFocus={() => setFocus(sessionId)}
            />
          );
        })}
      </div>
    </div>
  );
}

function DispatchSection({
  dispatches,
  onFocus,
}: {
  dispatches: Dispatch[];
  onFocus: () => void;
}) {
  if (dispatches.length === 0) return null;
  return (
    <div className="mt-1.5 grid grid-cols-1 gap-1">
      {dispatches.map((d) => (
        <DispatchCard key={d.id} dispatch={d} onClick={onFocus} />
      ))}
    </div>
  );
}

export const SessionCardList = memo(function SessionCardList({
  fleetId,
}: SessionCardListProps) {
  const focusedSessionId = useSessionStore((s) => s.focusedSessionId);
  const setFocus = useSessionStore((s) => s.setFocus);
  const sessions = useSessionStore((s) => s.sessions);
  const dispatches = useSessionStore((s) => s.dispatches);

  const dockSessionId = commanderSessionId("dock", fleetId);
  const flagshipSessionId = commanderSessionId("flagship", fleetId);
  const dockSession = sessions.get(dockSessionId);
  const flagshipSession = sessions.get(flagshipSessionId);

  const dockDispatches = useMemo(() => {
    const result: Dispatch[] = [];
    for (const d of dispatches.values()) {
      if (d.parentRole === "dock" && d.fleetId === fleetId) result.push(d);
    }
    return result.sort((a, b) => b.startedAt - a.startedAt);
  }, [dispatches, fleetId]);

  const flagshipDispatches = useMemo(() => {
    const result: Dispatch[] = [];
    for (const d of dispatches.values()) {
      if (d.parentRole === "flagship" && d.fleetId === fleetId) result.push(d);
    }
    return result.sort((a, b) => b.startedAt - a.startedAt);
  }, [dispatches, fleetId]);

  return (
    <div className="w-[420px] shrink-0 border-l border-border bg-background/50 flex flex-col min-h-0">
      {/* Scrollable sections: Commander cards → Ships */}
      <ScrollArea className="flex-1">
        <div className="divide-y divide-border">
          {/* Dock */}
          {dockSession && (
            <div className="px-3 py-2">
              <h3 className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
                Dock
              </h3>
              <SessionCard
                session={dockSession}
                isFocused={focusedSessionId === dockSessionId}
                onFocus={() => setFocus(dockSessionId)}
              />
              <DispatchSection
                dispatches={dockDispatches}
                onFocus={() => setFocus(dockSessionId)}
              />
            </div>
          )}

          {/* Flagship */}
          {flagshipSession && (
            <div className="px-3 py-2">
              <h3 className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
                Flagship
              </h3>
              <SessionCard
                session={flagshipSession}
                isFocused={focusedSessionId === flagshipSessionId}
                onFocus={() => setFocus(flagshipSessionId)}
              />
              <DispatchSection
                dispatches={flagshipDispatches}
                onFocus={() => setFocus(flagshipSessionId)}
              />
            </div>
          )}

          {/* Ships */}
          <ShipsSection fleetId={fleetId} />
        </div>
      </ScrollArea>
    </div>
  );
});
