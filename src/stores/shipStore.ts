import { create } from "zustand";
import type { Ship, ShipStatus, StreamMessage, AcceptanceTestRequest } from "@/types";
import { wsClient } from "@/lib/ws-client";

interface ShipStatusData {
  fleetId?: string;
  repo?: string;
  issueNumber?: number;
  issueTitle?: string;
}

interface ShipState {
  ships: Map<string, Ship>;
  shipLogs: Map<string, StreamMessage[]>;
  selectedShipId: string | null;

  addShip: (ship: Partial<Ship> & { id: string; status: ShipStatus }) => void;
  setShipStatus: (id: string, status: ShipStatus, extra?: ShipStatusData) => void;
  addShipLog: (id: string, message: StreamMessage) => void;
  setAcceptanceTest: (id: string, test: AcceptanceTestRequest) => void;
  setShipDone: (id: string, prUrl?: string, merged?: boolean) => void;
  selectShip: (id: string | null) => void;

  syncShips: (ships: Ship[]) => void;
  fetchShips: () => void;
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

  addShip: (shipData) => {
    set((state) => {
      const ships = new Map(state.ships);
      ships.set(shipData.id, {
        fleetId: "",
        repo: "",
        issueNumber: 0,
        issueTitle: "",
        branchName: "",
        worktreePath: "",
        sessionId: null,
        prUrl: null,
        acceptanceTest: null,
        acceptanceTestApproved: false,
        createdAt: new Date().toISOString(),
        ...shipData,
      } as Ship);
      return { ships };
    });
  },

  setShipStatus: (id, status, extra) => {
    set((state) => {
      const ships = new Map(state.ships);
      const existing = ships.get(id);
      if (existing) {
        ships.set(id, {
          ...existing,
          status,
          ...(extra?.fleetId && { fleetId: extra.fleetId }),
          ...(extra?.repo && { repo: extra.repo }),
          ...(extra?.issueNumber && { issueNumber: extra.issueNumber }),
          ...(extra?.issueTitle && { issueTitle: extra.issueTitle }),
        });
      } else {
        ships.set(id, {
          id,
          fleetId: extra?.fleetId ?? "",
          repo: extra?.repo ?? "",
          issueNumber: extra?.issueNumber ?? 0,
          issueTitle: extra?.issueTitle ?? "",
          status,
          branchName: "",
          worktreePath: "",
          sessionId: null,
          prUrl: null,
          acceptanceTest: null,
          acceptanceTestApproved: false,
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

  syncShips: (shipList) => {
    set((state) => {
      const ships = new Map(state.ships);
      // Add/update ships from server, but keep locally-known ships
      // that may have received more recent status updates
      for (const s of shipList) {
        const existing = ships.get(s.id);
        if (!existing) {
          ships.set(s.id, s);
        } else {
          // Keep the existing entry if it has a more advanced status
          ships.set(s.id, { ...s, ...existing });
        }
      }
      return { ships };
    });
  },

  fetchShips: () => {
    wsClient.send({ type: "ship:list" });
  },

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
