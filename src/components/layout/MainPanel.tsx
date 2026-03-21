import { useUIStore } from "@/stores/uiStore";
import { useFleetStore } from "@/stores/fleetStore";
import { Bridge } from "@/components/bridge/Bridge";
import { BridgeShipBar } from "@/components/bridge/BridgeShipBar";
import { ShipGrid } from "@/components/ship/ShipGrid";
import { FleetSettings } from "@/components/fleet/FleetSettings";
import { cn } from "@/lib/utils";
import { Flag, Anchor } from "lucide-react";
import type { CommanderRole } from "@/types";

const TABS: Array<{ role: CommanderRole; label: string; icon: typeof Flag; description: string }> = [
  { role: "flagship", label: "Flagship", icon: Flag, description: "Ship management" },
  { role: "dock", label: "Dock", icon: Anchor, description: "Issue management" },
];

export function MainPanel() {
  const mainView = useUIStore((s) => s.mainView);
  const activeCommanderTab = useUIStore((s) => s.activeCommanderTab);
  const setActiveCommanderTab = useUIStore((s) => s.setActiveCommanderTab);
  const selectedFleetId = useFleetStore((s) => s.selectedFleetId);

  if (!selectedFleetId && mainView !== "fleet-settings") {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <div className="text-center">
          <p className="text-lg font-medium">Select or create a Fleet</p>
          <p className="text-sm mt-1">
            Choose a fleet from the sidebar to begin
          </p>
        </div>
      </div>
    );
  }

  switch (mainView) {
    case "command":
      return (
        <div className="flex flex-1 min-h-0">
          <div className="flex flex-1 flex-col min-h-0">
            {/* Commander Tab Bar */}
            <div className="flex border-b border-border">
              {TABS.map((tab) => {
                const Icon = tab.icon;
                const active = activeCommanderTab === tab.role;
                return (
                  <button
                    key={tab.role}
                    onClick={() => setActiveCommanderTab(tab.role)}
                    className={cn(
                      "flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px",
                      active
                        ? "border-primary text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {tab.label}
                    <span className="text-xs text-muted-foreground hidden sm:inline">
                      — {tab.description}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Active Commander Chat */}
            <Bridge fleetId={selectedFleetId} role={activeCommanderTab} />
          </div>
          <BridgeShipBar fleetId={selectedFleetId!} />
        </div>
      );
    case "ships":
      return <ShipGrid fleetId={selectedFleetId} />;
    case "fleet-settings":
      return <FleetSettings />;
    default:
      return null;
  }
}
