/** @deprecated Use useCommander instead. */
import { useCommander } from "./useCommander";

export function useBridge(fleetId: string | null) {
  return useCommander(fleetId, "flagship");
}
