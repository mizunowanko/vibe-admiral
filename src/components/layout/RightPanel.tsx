import { memo, useState, useMemo, useRef } from "react";
import { useUIStore } from "@/stores/uiStore";
import { useShipStore } from "@/stores/shipStore";
import { ActiveShipSummary } from "@/components/ship/ActiveShipSummary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { STATUS_CONFIG, PROCESS_DEAD_CONFIG } from "@/lib/ship-status";
import { Flag, Anchor, Square } from "lucide-react";
import type { Ship, CommanderRole } from "@/types";

interface RightPanelProps {
  fleetId: string;
}

function buildFleetShipFingerprint(ships: Ship[]): string {
  return ships
    .map((s) => `${s.id}:${s.phase}:${s.issueNumber}:${s.issueTitle}:${s.isCompacting}:${s.gateCheck?.status ?? ""}:${s.processDead ?? false}:${s.repo}`)
    .join("|");
}

const COMMANDER_SECTIONS: Array<{
  role: CommanderRole;
  label: string;
  description: string;
  icon: typeof Flag;
}> = [
  {
    role: "dock",
    label: "Dock",
    description: "Issue management — triage, clarity, priority",
    icon: Anchor,
  },
  {
    role: "flagship",
    label: "Flagship",
    description: "Ship management — sortie, monitor, stop, resume",
    icon: Flag,
  },
];

function CommanderSection({
  role,
  label,
  description,
  icon: Icon,
}: {
  role: CommanderRole;
  label: string;
  description: string;
  icon: typeof Flag;
}) {
  const activeCommanderTab = useUIStore((s) => s.activeCommanderTab);
  const setActiveCommanderTab = useUIStore((s) => s.setActiveCommanderTab);
  const isActive = activeCommanderTab === role;

  return (
    <div className="px-3 py-2">
      <h3 className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
        {label}
      </h3>
      <button
        onClick={() => setActiveCommanderTab(role)}
        className={cn(
          "w-full rounded-md border px-3 py-2 text-left text-xs transition-colors",
          isActive
            ? "border-primary bg-primary/5 text-foreground"
            : "border-border bg-card hover:border-primary/50 text-muted-foreground hover:text-foreground",
        )}
      >
        <div className="flex items-center gap-2">
          <Icon className="h-3.5 w-3.5 shrink-0" />
          <span className="font-medium">{label}</span>
          {isActive && (
            <Badge className="ml-auto text-[10px] px-1 py-0 bg-primary/20 text-primary">
              Active
            </Badge>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground mt-1">{description}</p>
      </button>
    </div>
  );
}

function ShipsSection({ fleetId }: { fleetId: string }) {
  const stopShip = useShipStore((s) => s.stopShip);
  const setViewingShipId = useUIStore((s) => s.setViewingShipId);
  const [showInactive, setShowInactive] = useState(false);

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
      showInactive
        ? allFleetShips
        : allFleetShips.filter((s) => s.phase !== "done" && s.phase !== "stopped" && !s.processDead),
    [allFleetShips, showInactive],
  );

  return (
    <div className="px-3 py-2">
      <div className="flex items-center justify-between mb-1.5">
        <h3 className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
          Ships
        </h3>
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
            <span className="text-[10px] text-muted-foreground">Show inactive</span>
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
    </div>
  );
}

export const RightPanel = memo(function RightPanel({ fleetId }: RightPanelProps) {
  return (
    <div className="w-[420px] shrink-0 border-l border-border bg-background/50 flex flex-col min-h-0">
      {/* Active Ship Summary — always visible */}
      <ActiveShipSummary fleetId={fleetId} />

      {/* Scrollable sections: Dock → Flagship → Ships */}
      <ScrollArea className="flex-1">
        <div className="divide-y divide-border">
          {COMMANDER_SECTIONS.map((section) => (
            <CommanderSection key={section.role} {...section} />
          ))}
          <ShipsSection fleetId={fleetId} />
        </div>
      </ScrollArea>
    </div>
  );
});
