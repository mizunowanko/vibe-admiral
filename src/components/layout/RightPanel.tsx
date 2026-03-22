import { memo, useState, useMemo, useRef } from "react";
import { useUIStore } from "@/stores/uiStore";
import { useShipStore } from "@/stores/shipStore";
import { ShipDetailPanel } from "@/components/ship/ShipDetailPanel";
import { ActiveShipSummary } from "@/components/ship/ActiveShipSummary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { STATUS_CONFIG, PROCESS_DEAD_CONFIG } from "@/lib/ship-status";
import { Flag, Anchor, Ship as ShipIcon, Square } from "lucide-react";
import type { Ship, RightPanelTab } from "@/types";

interface RightPanelProps {
  fleetId: string;
}

const TABS: Array<{ key: RightPanelTab; label: string; icon: typeof Flag }> = [
  { key: "flagship", label: "Flagship", icon: Flag },
  { key: "dock", label: "Dock", icon: Anchor },
  { key: "ships", label: "Ships", icon: ShipIcon },
];

function buildFleetShipFingerprint(ships: Ship[]): string {
  return ships
    .map((s) => `${s.id}:${s.phase}:${s.issueNumber}:${s.issueTitle}:${s.isCompacting}:${s.gateCheck?.status ?? ""}:${s.processDead ?? false}:${s.repo}`)
    .join("|");
}

function ShipsTabContent({ fleetId }: { fleetId: string }) {
  const stopShip = useShipStore((s) => s.stopShip);
  const setViewingShipId = useUIStore((s) => s.setViewingShipId);
  const [showCompleted, setShowCompleted] = useState(false);

  const prevRef = useRef<{ fingerprint: string; ships: Ship[] }>({ fingerprint: "", ships: [] });
  const allFleetShips = useShipStore((s) => {
    const filtered = Array.from(s.ships.values()).filter((ship) => ship.fleetId === fleetId);
    const fingerprint = buildFleetShipFingerprint(filtered);
    if (fingerprint === prevRef.current.fingerprint) {
      return prevRef.current.ships;
    }
    prevRef.current = { fingerprint, ships: filtered };
    return filtered;
  });

  const fleetShips = useMemo(
    () =>
      showCompleted
        ? allFleetShips
        : allFleetShips.filter((s) => s.phase !== "done" && s.phase !== "stopped" && !s.processDead),
    [allFleetShips, showCompleted],
  );

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-medium text-muted-foreground">
          {fleetShips.length} ship{fleetShips.length !== 1 ? "s" : ""}
        </span>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={(e) => setShowCompleted(e.target.checked)}
            className="h-3 w-3 rounded border-border accent-primary"
          />
          <span className="text-[10px] text-muted-foreground">Show completed</span>
        </label>
      </div>
      <ScrollArea className="flex-1">
        <div className="grid grid-cols-1 gap-2 p-3">
          {fleetShips.length === 0 && (
            <p className="text-center text-xs text-muted-foreground py-4">
              No active ships
            </p>
          )}
          {fleetShips.map((ship) => {
            const config = ship.processDead
              ? PROCESS_DEAD_CONFIG
              : STATUS_CONFIG[ship.phase];
            const isActive = ship.phase !== "done" && ship.phase !== "stopped" && !ship.processDead;

            return (
              <div
                key={ship.id}
                onClick={() => setViewingShipId(ship.id)}
                className={cn(
                  "cursor-pointer rounded-md border border-border bg-card px-3 py-2 text-xs transition-colors hover:border-primary/50",
                  ship.gateCheck?.status === "pending" &&
                    "border-sky-500/50 ring-1 ring-sky-500/20",
                )}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-mono text-muted-foreground">
                      #{ship.issueNumber}
                    </span>
                    <Badge className={cn("text-[10px] px-1 py-0", config.color)}>
                      {config.animate && (
                        <span className="mr-0.5 inline-block h-1 w-1 rounded-full bg-current animate-pulse" />
                      )}
                      {config.label}
                    </Badge>
                    {ship.isCompacting && (
                      <Badge className="text-[10px] px-1 py-0 bg-purple-500/20 text-purple-400">
                        <span className="mr-0.5 inline-block h-1 w-1 rounded-full bg-current animate-pulse" />
                        Compact
                      </Badge>
                    )}
                    {ship.gateCheck?.status === "pending" && (
                      <Badge className="text-[10px] px-1 py-0 bg-sky-500/20 text-sky-400">
                        <span className="mr-0.5 inline-block h-1 w-1 rounded-full bg-current animate-pulse" />
                        Gate
                      </Badge>
                    )}
                  </div>
                  {isActive && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 shrink-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        stopShip(ship.id);
                      }}
                    >
                      <Square className="h-2.5 w-2.5" />
                    </Button>
                  )}
                </div>
                <p className="truncate text-foreground">
                  {ship.issueTitle || `Issue #${ship.issueNumber}`}
                </p>
                <p className="truncate text-muted-foreground mt-0.5">
                  {ship.repo}
                </p>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

export const RightPanel = memo(function RightPanel({ fleetId }: RightPanelProps) {
  const rightPanelTab = useUIStore((s) => s.rightPanelTab);
  const setRightPanelTab = useUIStore((s) => s.setRightPanelTab);
  const viewingShipId = useUIStore((s) => s.viewingShipId);

  return (
    <div className="w-[420px] shrink-0 border-l border-border bg-background/50 flex flex-col min-h-0">
      {/* Active Ship Summary — always visible */}
      <ActiveShipSummary fleetId={fleetId} />

      {/* Tab Bar — Flagship/Dock tabs switch the left chat panel, Ships tab is for the ship list */}
      <div className="flex border-b border-border shrink-0">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const active = rightPanelTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setRightPanelTab(tab.key)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px flex-1 justify-center",
                active
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
              )}
            >
              <Icon className="h-3 w-3" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Content: Ship Detail Panel or Ships List */}
      {viewingShipId ? (
        <ShipDetailPanel shipId={viewingShipId} />
      ) : (
        <ShipsTabContent fleetId={fleetId} />
      )}
    </div>
  );
});
