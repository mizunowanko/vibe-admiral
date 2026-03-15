import { create } from "zustand";
import type { Fleet } from "@/types";
import { wsClient } from "@/lib/ws-client";

interface FleetState {
  fleets: Fleet[];
  selectedFleetId: string | null;
  selectedFleet: Fleet | null;

  setFleets: (fleets: Fleet[]) => void;
  selectFleet: (id: string | null) => void;
  createFleet: (name: string, repos: string[]) => void;
  updateFleet: (id: string, name?: string, repos?: string[]) => void;
  deleteFleet: (id: string) => void;
  fetchFleets: () => void;
}

export const useFleetStore = create<FleetState>((set, get) => ({
  fleets: [],
  selectedFleetId: null,
  selectedFleet: null,

  setFleets: (fleets) => {
    const { selectedFleetId } = get();
    set({
      fleets,
      selectedFleet: fleets.find((f) => f.id === selectedFleetId) ?? null,
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

  updateFleet: (id, name, repos) => {
    wsClient.send({ type: "fleet:update", data: { id, name, repos } });
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
}));
