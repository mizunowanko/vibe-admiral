import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Fleet, FleetRepo, FleetSkillSources } from "@/types";
import { wsClient } from "@/lib/ws-client";

interface FleetState {
  fleets: Fleet[];
  selectedFleetId: string | null;
  selectedFleet: Fleet | null;

  setFleets: (fleets: Fleet[]) => void;
  selectFleet: (id: string | null) => void;
  createFleet: (name: string, repos: FleetRepo[]) => void;
  updateFleet: (id: string, updates: {
    name?: string;
    repos?: FleetRepo[];
    skillSources?: FleetSkillSources;
    sharedRulePaths?: string[];
    flagshipRulePaths?: string[];
    dockRulePaths?: string[];
    shipRulePaths?: string[];
    maxConcurrentSorties?: number;
  }) => void;
  deleteFleet: (id: string) => void;
  fetchFleets: () => void;
}

export const useFleetStore = create<FleetState>()(
  persist(
    (set, get) => ({
      fleets: [],
      selectedFleetId: null,
      selectedFleet: null,

      setFleets: (fleets) => {
        const { selectedFleetId } = get();
        const selectedFleet = fleets.find((f) => f.id === selectedFleetId) ?? null;
        set({
          fleets,
          selectedFleet,
          // Clear persisted ID only when the fleet list is non-empty but
          // the selected fleet is genuinely missing. An empty array may
          // arrive during a transient reconnection; clearing in that case
          // would cause the UI to jump to the Fleet selection screen.
          ...(selectedFleetId && !selectedFleet && fleets.length > 0 && { selectedFleetId: null }),
        });
      },

      selectFleet: (id) => {
        const fleet = get().fleets.find((f) => f.id === id) ?? null;
        set({ selectedFleetId: id, selectedFleet: fleet });
        if (id) {
          wsClient.send({ type: "fleet:select", data: { id } });
        }
      },

      createFleet: (name, repos) => {
        wsClient.send({ type: "fleet:create", data: { name, repos } });
      },

      updateFleet: (id, updates) => {
        wsClient.send({ type: "fleet:update", data: { id, ...updates } });
      },

      deleteFleet: (id) => {
        const { selectedFleetId } = get();
        if (selectedFleetId === id) {
          set({ selectedFleetId: null, selectedFleet: null });
        }
        wsClient.send({ type: "fleet:delete", data: { id } });
      },

      fetchFleets: () => {
        wsClient.send({ type: "fleet:list" });
      },
    }),
    {
      name: "admiral-fleet",
      partialize: (state) => ({ selectedFleetId: state.selectedFleetId }),
    },
  ),
);
