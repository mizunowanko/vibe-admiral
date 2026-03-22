import { useUIStore } from "@/stores/uiStore";
import { useFleetStore } from "@/stores/fleetStore";
import { Bridge } from "@/components/bridge/Bridge";
import { RightPanel } from "@/components/layout/RightPanel";
import { ShipDetailPanel } from "@/components/ship/ShipDetailPanel";
import { ShipGrid } from "@/components/ship/ShipGrid";
import { FleetSettings } from "@/components/fleet/FleetSettings";
import type { CommanderRole } from "@/types";

export function MainPanel() {
  const mainView = useUIStore((s) => s.mainView);
  const activeCommanderTab = useUIStore((s) => s.activeCommanderTab);
  const viewingShipId = useUIStore((s) => s.viewingShipId);
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
          {/* Center: Commander Chat or Ship Detail */}
          {viewingShipId ? (
            <ShipDetailPanel shipId={viewingShipId} />
          ) : (
            <>
              {(["dock", "flagship"] as const satisfies readonly CommanderRole[]).map((role) => (
                <div key={role} className={activeCommanderTab === role ? "flex flex-1 min-h-0 flex-col" : "hidden"}>
                  <Bridge fleetId={selectedFleetId} role={role} />
                </div>
              ))}
            </>
          )}

          {/* Right: Dock → Flagship → Ships (stacked) */}
          <RightPanel fleetId={selectedFleetId!} />
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
