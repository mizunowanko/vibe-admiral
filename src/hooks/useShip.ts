import { useMemo } from "react";
import { useShipStore } from "@/stores/shipStore";
import type { Ship } from "@/types";

const EMPTY_LOGS: import("@/types").StreamMessage[] = [];

export function useShip(shipId: string | null) {
  const ship = useShipStore((s) =>
    shipId ? s.ships.get(shipId) ?? null : null,
  );

  const logs = useShipStore((s) =>
    shipId ? s.shipLogs.get(shipId) ?? EMPTY_LOGS : EMPTY_LOGS,
  );

  const escortLogs = useShipStore((s) =>
    shipId ? s.escortLogs.get(shipId) ?? EMPTY_LOGS : EMPTY_LOGS,
  );

  return { ship, logs, escortLogs };
}

export function useShipsByFleet(fleetId: string | null): Ship[] {
  const ships = useShipStore((s) => s.ships);

  return useMemo(() => {
    if (!fleetId) return [];
    return Array.from(ships.values()).filter((s) => s.fleetId === fleetId);
  }, [ships, fleetId]);
}
