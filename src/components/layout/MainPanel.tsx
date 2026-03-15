import { useUIStore } from "@/stores/uiStore";
import { useFleetStore } from "@/stores/fleetStore";
import { Bridge } from "@/components/bridge/Bridge";
import { BridgeShipBar } from "@/components/bridge/BridgeShipBar";
import { ShipGrid } from "@/components/ship/ShipGrid";
import { FleetSettings } from "@/components/fleet/FleetSettings";

export function MainPanel() {
  const mainView = useUIStore((s) => s.mainView);
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
    case "bridge":
      return (
        <div className="flex flex-1 min-h-0">
          <Bridge fleetId={selectedFleetId} />
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
