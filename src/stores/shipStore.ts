import { create } from "zustand";
import type { Ship, Phase, StreamMessage, GateCheckState } from "@/types";
import { wsClient } from "@/lib/ws-client";
import * as api from "@/lib/api-client";

interface ShipPhaseData {
  fleetId?: string;
  repo?: string;
  issueNumber?: number;
  issueTitle?: string;
}

// --- Log batching ---
// Buffer incoming logs and flush once per animation frame to avoid
// creating a new Map reference on every single CLI output line.
const pendingLogs = new Map<string, StreamMessage[]>();
let flushScheduled = false;

function scheduleBatchFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(() => {
    flushScheduled = false;
    const batch = new Map(pendingLogs);
    pendingLogs.clear();
    if (batch.size === 0) return;
    useShipStore.setState((state) => {
      const shipLogs = new Map(state.shipLogs);
      for (const [id, msgs] of batch) {
        const existing = shipLogs.get(id) ?? [];
        shipLogs.set(id, [...existing, ...msgs]);
      }
      return { shipLogs };
    });
  });
}

interface ShipState {
  ships: Map<string, Ship>;
  shipLogs: Map<string, StreamMessage[]>;

  addShip: (ship: Partial<Ship> & { id: string; phase: Phase }) => void;
  setShipPhase: (id: string, phase: Phase, extra?: ShipPhaseData) => void;
  setShipCompacting: (id: string, isCompacting: boolean) => void;
  addShipLog: (id: string, message: StreamMessage) => void;
  setShipLogs: (id: string, messages: StreamMessage[]) => void;
  setGateCheck: (id: string, gateCheck: GateCheckState) => void;
  clearGateCheck: (id: string) => void;
  setShipDone: (id: string, prUrl?: string, merged?: boolean) => void;

  syncShips: (ships: Ship[]) => void;
  fetchShips: (fleetId?: string) => Promise<void>;
  sortie: (fleetId: string, repo: string, issueNumber: number) => Promise<void>;
  chatWithShip: (id: string, message: string) => void;
  retryShip: (id: string) => Promise<void>;
  stopShip: (id: string) => Promise<void>;
}

export const useShipStore = create<ShipState>((set) => ({
  ships: new Map(),
  shipLogs: new Map(),

  addShip: (shipData) => {
    set((state) => {
      const ships = new Map(state.ships);
      ships.set(shipData.id, {
        fleetId: "",
        repo: "",
        issueNumber: 0,
        issueTitle: "",
        isCompacting: false,
        branchName: "",
        worktreePath: "",
        sessionId: null,
        prUrl: null,
        prReviewStatus: null,
        gateCheck: null,
        retryCount: 0,
        createdAt: new Date().toISOString(),
        ...shipData,
      } as Ship);
      return { ships };
    });
  },

  setShipPhase: (id, phase, extra) => {
    set((state) => {
      const ships = new Map(state.ships);
      const existing = ships.get(id);
      if (existing) {
        ships.set(id, {
          ...existing,
          phase,
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
          phase,
          isCompacting: false,
          branchName: "",
          worktreePath: "",
          sessionId: null,
          prUrl: null,
          prReviewStatus: null,
          gateCheck: null,
            retryCount: 0,
          createdAt: new Date().toISOString(),
        });
      }
      return { ships };
    });
  },

  setShipCompacting: (id, isCompacting) => {
    set((state) => {
      const ships = new Map(state.ships);
      const ship = ships.get(id);
      if (ship) {
        ships.set(id, { ...ship, isCompacting });
      }
      return { ships };
    });
  },

  addShipLog: (id, message) => {
    const buf = pendingLogs.get(id) ?? [];
    buf.push(message);
    pendingLogs.set(id, buf);
    scheduleBatchFlush();
  },

  setShipLogs: (id, messages) => {
    set((state) => {
      const shipLogs = new Map(state.shipLogs);
      shipLogs.set(id, messages);
      return { shipLogs };
    });
  },

  setGateCheck: (id, gateCheck) => {
    set((state) => {
      const ships = new Map(state.ships);
      const ship = ships.get(id);
      if (ship) {
        ships.set(id, { ...ship, gateCheck });
      }
      return { ships };
    });
  },

  clearGateCheck: (id) => {
    set((state) => {
      const ships = new Map(state.ships);
      const ship = ships.get(id);
      if (ship) {
        ships.set(id, { ...ship, gateCheck: null });
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
          phase: "done",
          prUrl: prUrl ?? ship.prUrl,
        });
      }
      return { ships };
    });
  },


  syncShips: (shipList) => {
    set((state) => {
      const ships = new Map(state.ships);
      for (const s of shipList) {
        // Server is the source of truth — always prefer server state.
        ships.set(s.id, s);
      }
      return { ships };
    });
  },

  fetchShips: async (fleetId) => {
    try {
      const ships = await api.fetchShips(fleetId);
      useShipStore.getState().syncShips(ships);
    } catch (err) {
      console.error("[shipStore] fetchShips failed:", err);
    }
  },

  sortie: async (fleetId, repo, issueNumber) => {
    try {
      await api.sortie(fleetId, repo, issueNumber);
    } catch (err) {
      console.error("[shipStore] sortie failed:", err);
    }
  },

  chatWithShip: (id, message) => {
    wsClient.send({ type: "ship:chat", data: { id, message } });
  },

  retryShip: async (id) => {
    try {
      await api.resumeShip(id);
    } catch (err) {
      console.error("[shipStore] retryShip failed:", err);
    }
  },

  stopShip: async (id) => {
    try {
      await api.stopShip(id);
    } catch (err) {
      console.error("[shipStore] stopShip failed:", err);
    }
  },
}));
