import { useFleetStore } from "@/stores/fleetStore";
import { useShipsByFleet } from "@/hooks/useShip";
import { cn } from "@/lib/utils";
import { Ship } from "lucide-react";

export function FleetList() {
  const fleets = useFleetStore((s) => s.fleets);
  const selectedFleetId = useFleetStore((s) => s.selectedFleetId);
  const selectFleet = useFleetStore((s) => s.selectFleet);

  return (
    <div className="space-y-1">
      {fleets.map((fleet) => (
        <FleetItem
          key={fleet.id}
          name={fleet.name}
          selected={selectedFleetId === fleet.id}
          fleetId={fleet.id}
          onClick={() => selectFleet(fleet.id)}
        />
      ))}
    </div>
  );
}

interface FleetItemProps {
  name: string;
  selected: boolean;
  fleetId: string;
  onClick: () => void;
}

function FleetItem({
  name,
  selected,
  fleetId,
  onClick,
}: FleetItemProps) {
  const ships = useShipsByFleet(fleetId);
  const activeCount = ships.filter(
    (s) => s.phase !== "done" && s.phase !== "paused" && s.phase !== "abandoned" && !s.processDead,
  ).length;

  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
        selected
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent/50",
      )}
    >
      <Ship className="h-4 w-4 shrink-0" />
      <span className="truncate flex-1 text-left">{name}</span>
      {activeCount > 0 && (
        <span className="text-[10px] font-mono text-primary">
          {activeCount}
        </span>
      )}
    </button>
  );
}
