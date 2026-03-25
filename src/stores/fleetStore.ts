import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Fleet, FleetRepo, FleetSkillSources, CustomInstructions, FleetGateSettings } from "@/types";
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
    customInstructions?: CustomInstructions;
    maxConcurrentSorties?: number;
    gates?: FleetGateSettings;
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
        // Never reset selectedFleetId from setFleets(). During WS
        // reconnection the fleet list may arrive incomplete/empty before
        // the full list is available, causing a transient null that
        // unmounts the entire MainPanel and destroys draft state.
        // selectedFleetId is only cleared explicitly via selectFleet()
        // or deleteFleet().
        set({ fleets, selectedFleet });
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
