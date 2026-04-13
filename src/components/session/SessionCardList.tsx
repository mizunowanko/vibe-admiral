import { memo, useState, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useSessionStore, commanderSessionId, shipSessionId } from "@/stores/sessionStore";
import { useShipStore } from "@/stores/shipStore";
import { ActiveShipSummary } from "@/components/ship/ActiveShipSummary";
import { SessionCard, DispatchCard } from "./SessionCard";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Dispatch } from "@/types";

interface SessionCardListProps {
  fleetId: string;
}

function ShipsSection({ fleetId }: { fleetId: string }) {
  const focusedSessionId = useSessionStore((s) => s.focusedSessionId);
  const setFocus = useSessionStore((s) => s.setFocus);
  const sessions = useSessionStore((s) => s.sessions);
  const [showInactive, setShowInactive] = useState(false);

  const allFleetShips = useShipStore(
    useShallow((s) =>
      Array.from(s.ships.values()).filter((ship) => ship.fleetId === fleetId),
    ),
  );

  const fleetShips = useMemo(
    () =>
      showInactive
        ? allFleetShips
        : allFleetShips.filter(
            (s) =>
              s.phase !== "done" &&
              s.phase !== "paused" &&
              s.phase !== "abandoned" &&
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
              onFocus={() => setFocus(sessionId, "user-click")}
            />
          );
        })}
      </div>
    </div>
  );
}

function DispatchCards({
  dispatches,
  focusedSessionId,
  onFocusDispatch,
}: {
  dispatches: Dispatch[];
  focusedSessionId: string | null;
  onFocusDispatch: (dispatchId: string) => void;
}) {
  if (dispatches.length === 0) return null;
  return (
    <div className="grid grid-cols-1 gap-1 mt-1">
      {dispatches.map((d) => (
        <DispatchCard
          key={d.id}
          dispatch={d}
          isFocused={focusedSessionId === `dispatch-${d.id}`}
          onClick={() => onFocusDispatch(d.id)}
        />
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

  const { dockDispatches, flagshipDispatches } = useMemo(() => {
    const dock: Dispatch[] = [];
    const flagship: Dispatch[] = [];
    for (const d of dispatches.values()) {
      if (d.fleetId !== fleetId) continue;
      if (d.parentRole === "dock") dock.push(d);
      else if (d.parentRole === "flagship") flagship.push(d);
    }
    const byTime = (a: Dispatch, b: Dispatch) => b.startedAt - a.startedAt;
    return {
      dockDispatches: dock.sort(byTime),
      flagshipDispatches: flagship.sort(byTime),
    };
  }, [dispatches, fleetId]);

  return (
    <div className="h-full border-l border-border bg-background/50 flex flex-col min-h-0">
      {/* Scrollable sections: Commander cards (with their Dispatches) → Ships */}
      <ScrollArea className="flex-1">
        <div className="divide-y divide-border">
          {/* Dock + its Dispatches */}
          {(dockSession || dockDispatches.length > 0) && (
            <div className="px-3 py-2">
              <h3 className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
                Dock
              </h3>
              {dockSession && (
                <SessionCard
                  session={dockSession}
                  isFocused={focusedSessionId === dockSessionId}
                  onFocus={() => setFocus(dockSessionId, "user-click")}
                />
              )}
              <DispatchCards
                dispatches={dockDispatches}
                focusedSessionId={focusedSessionId}
                onFocusDispatch={(id) => setFocus(`dispatch-${id}`, "user-click")}
              />
            </div>
          )}

          {/* Flagship + its Dispatches */}
          {(flagshipSession || flagshipDispatches.length > 0) && (
            <div className="px-3 py-2">
              <h3 className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
                Flagship
              </h3>
              {flagshipSession && (
                <SessionCard
                  session={flagshipSession}
                  isFocused={focusedSessionId === flagshipSessionId}
                  onFocus={() => setFocus(flagshipSessionId, "user-click")}
                />
              )}
              <DispatchCards
                dispatches={flagshipDispatches}
                focusedSessionId={focusedSessionId}
                onFocusDispatch={(id) => setFocus(`dispatch-${id}`, "user-click")}
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
