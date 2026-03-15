import { useShipStore } from "@/stores/shipStore";
import type { ShipStatus } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { Square, ExternalLink } from "lucide-react";

const STATUS_CONFIG: Record<
  ShipStatus,
  { label: string; color: string; animate?: boolean }
> = {
  sortie: { label: "Sortie", color: "bg-yellow-500/20 text-yellow-400", animate: true },
  investigating: { label: "Investigating", color: "bg-blue-500/20 text-blue-400", animate: true },
  planning: { label: "Planning", color: "bg-indigo-500/20 text-indigo-400", animate: true },
  implementing: { label: "Implementing", color: "bg-violet-500/20 text-violet-400", animate: true },
  testing: { label: "Testing", color: "bg-cyan-500/20 text-cyan-400", animate: true },
  reviewing: { label: "Reviewing", color: "bg-orange-500/20 text-orange-400", animate: true },
  "acceptance-test": { label: "Acceptance Test", color: "bg-amber-500/20 text-amber-400" },
  merging: { label: "Merging", color: "bg-emerald-500/20 text-emerald-400", animate: true },
  done: { label: "Done", color: "bg-green-500/20 text-green-400" },
  error: { label: "Error", color: "bg-red-500/20 text-red-400" },
};

interface BridgeShipBarProps {
  fleetId: string;
}

export function BridgeShipBar({ fleetId }: BridgeShipBarProps) {
  const ships = useShipStore((s) => s.ships);
  const stopShip = useShipStore((s) => s.stopShip);
  const acceptTest = useShipStore((s) => s.acceptTest);

  const fleetShips = Array.from(ships.values()).filter(
    (s) => s.fleetId === fleetId,
  );

  if (fleetShips.length === 0) return null;

  return (
    <div className="border-t border-border bg-background/50">
      <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border/50">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Ships ({fleetShips.length})
        </span>
      </div>
      <ScrollArea className="max-h-48">
        <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 lg:grid-cols-3">
          {fleetShips.map((ship) => {
            const config = STATUS_CONFIG[ship.status];
            const isActive = ship.status !== "done" && ship.status !== "error";

            return (
              <div
                key={ship.id}
                className={cn(
                  "rounded-md border border-border bg-card px-3 py-2 text-xs",
                  ship.status === "acceptance-test" &&
                    "border-amber-500/50 ring-1 ring-amber-500/20",
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
                  </div>
                  {isActive && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 shrink-0"
                      onClick={() => stopShip(ship.id)}
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

                {/* Acceptance test action */}
                {ship.status === "acceptance-test" && ship.acceptanceTest && (
                  <div className="mt-1.5 pt-1.5 border-t border-border flex items-center gap-2">
                    <a
                      href={ship.acceptanceTest.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline inline-flex items-center gap-0.5"
                    >
                      <ExternalLink className="h-2.5 w-2.5" />
                      Test
                    </a>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-5 text-[10px] px-1.5"
                      onClick={() => acceptTest(ship.id)}
                    >
                      Accept
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
