import { useMemo } from "react";
import { useShipStore } from "@/stores/shipStore";
import type { Ship } from "@/types";

export function useShip(shipId: string | null) {
  const ships = useShipStore((s) => s.ships);
  const shipLogs = useShipStore((s) => s.shipLogs);

  const ship = useMemo(
    () => (shipId ? ships.get(shipId) ?? null : null),
    [ships, shipId],
  );

  const logs = useMemo(
    () => (shipId ? shipLogs.get(shipId) ?? [] : []),
    [shipLogs, shipId],
  );

  return { ship, logs };
}

export function useShipsByFleet(fleetId: string | null): Ship[] {
  const ships = useShipStore((s) => s.ships);

  return useMemo(() => {
    if (!fleetId) return [];
    return Array.from(ships.values()).filter((s) => s.fleetId === fleetId);
  }, [ships, fleetId]);
}
