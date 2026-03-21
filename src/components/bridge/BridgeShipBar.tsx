import { useShipStore } from "@/stores/shipStore";
import { ShipLogPanel } from "@/components/ship/ShipLogPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { STATUS_CONFIG, PROCESS_DEAD_CONFIG } from "@/lib/ship-status";
import { Square } from "lucide-react";

interface BridgeShipBarProps {
  fleetId: string;
}

export function BridgeShipBar({ fleetId }: BridgeShipBarProps) {
  const ships = useShipStore((s) => s.ships);
  const selectedShipId = useShipStore((s) => s.selectedShipId);
  const selectShip = useShipStore((s) => s.selectShip);
  const stopShip = useShipStore((s) => s.stopShip);

  const fleetShips = Array.from(ships.values()).filter(
    (s) => s.fleetId === fleetId && s.phase !== "done" && !s.processDead,
  );

  if (fleetShips.length === 0) return null;

  // Only show log panel for ships belonging to this fleet
  const showLogPanel =
    selectedShipId && fleetShips.some((s) => s.id === selectedShipId);

  return (
    <div className="w-72 shrink-0 border-l border-border bg-background/50 flex flex-col">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Ships ({fleetShips.length})
        </span>
      </div>
      <ScrollArea className="flex-1">
        <div className="grid grid-cols-1 gap-2 p-3">
          {fleetShips.map((ship) => {
            const config = ship.processDead
              ? PROCESS_DEAD_CONFIG
              : STATUS_CONFIG[ship.phase];
            const isActive = ship.phase !== "done" && !ship.processDead;
            const isSelected = ship.id === selectedShipId;

            return (
              <div
                key={ship.id}
                onClick={() => selectShip(isSelected ? null : ship.id)}
                className={cn(
                  "cursor-pointer rounded-md border border-border bg-card px-3 py-2 text-xs transition-colors hover:border-primary/50",
                  ship.gateCheck?.status === "pending" &&
                    "border-sky-500/50 ring-1 ring-sky-500/20",
                  isSelected &&
                    "border-primary/70 bg-primary/5",
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

      {/* Ship Log Panel */}
      {showLogPanel && (
        <ShipLogPanel
          shipId={selectedShipId!}
          onClose={() => selectShip(null)}
        />
      )}
    </div>
  );
}
