import { create } from "zustand";
import type { Ship, ShipStatus, StreamMessage, AcceptanceTestRequest } from "@/types";
import { wsClient } from "@/lib/ws-client";

interface ShipState {
  ships: Map<string, Ship>;
  shipLogs: Map<string, StreamMessage[]>;
  selectedShipId: string | null;

  setShipStatus: (id: string, status: ShipStatus, detail?: string) => void;
  addShipLog: (id: string, message: StreamMessage) => void;
  setAcceptanceTest: (id: string, test: AcceptanceTestRequest) => void;
  setShipDone: (id: string, prUrl?: string, merged?: boolean) => void;
  selectShip: (id: string | null) => void;

  sortie: (fleetId: string, repo: string, issueNumber: number) => void;
  chatWithShip: (id: string, message: string) => void;
  acceptTest: (id: string) => void;
  rejectTest: (id: string, feedback: string) => void;
  stopShip: (id: string) => void;
}

export const useShipStore = create<ShipState>((set) => ({
  ships: new Map(),
  shipLogs: new Map(),
  selectedShipId: null,

  setShipStatus: (id, status, _detail) => {
    set((state) => {
      const ships = new Map(state.ships);
      const ship = ships.get(id);
      if (ship) {
        ships.set(id, { ...ship, status });
      } else {
        // Create a placeholder ship
        ships.set(id, {
          id,
          fleetId: "",
          repo: "",
          issueNumber: 0,
          issueTitle: "",
          status,
          branchName: "",
          worktreePath: "",
          sessionId: null,
          prUrl: null,
          acceptanceTest: null,
          createdAt: new Date().toISOString(),
        });
      }
      return { ships };
    });
  },

  addShipLog: (id, message) => {
    set((state) => {
      const shipLogs = new Map(state.shipLogs);
      const logs = shipLogs.get(id) ?? [];
      shipLogs.set(id, [...logs, message]);
      return { shipLogs };
    });
  },

  setAcceptanceTest: (id, test) => {
    set((state) => {
      const ships = new Map(state.ships);
      const ship = ships.get(id);
      if (ship) {
        ships.set(id, { ...ship, acceptanceTest: test, status: "acceptance-test" });
      }
      return { ships };
    });
  },

  setShipDone: (id, prUrl, _merged) => {
    set((state) => {
      const ships = new Map(state.ships);
      const ship = ships.get(id);
      if (ship) {
        ships.set(id, {
          ...ship,
          status: "done",
          prUrl: prUrl ?? ship.prUrl,
        });
      }
      return { ships };
    });
  },

  selectShip: (id) => set({ selectedShipId: id }),

  sortie: (fleetId, repo, issueNumber) => {
    wsClient.send({
      type: "ship:sortie",
      data: { fleetId, issueNumber, repo },
    });
  },

  chatWithShip: (id, message) => {
    wsClient.send({ type: "ship:chat", data: { id, message } });
  },

  acceptTest: (id) => {
    wsClient.send({ type: "ship:accept", data: { id } });
  },

  rejectTest: (id, feedback) => {
    wsClient.send({ type: "ship:reject", data: { id, feedback } });
  },

  stopShip: (id) => {
    wsClient.send({ type: "ship:stop", data: { id } });
  },
}));
