import { create } from "zustand";
import type { Ship, Phase, StreamMessage, GateCheckState } from "@/types";
import { wsClient } from "@/lib/ws-client";
import * as api from "@/lib/api-client";
import { useFleetStore } from "@/stores/fleetStore";
import { useSessionStore, createShipSession } from "@/stores/sessionStore";

interface ShipPhaseData {
  fleetId?: string;
  repo?: string;
  issueNumber?: number;
  issueTitle?: string;
}

// --- Log batching ---
// Buffer incoming logs and flush once per animation frame to avoid
// creating a new Map reference on every single CLI output line.
const pendingShipLogs = new Map<string, StreamMessage[]>();
const pendingEscortLogs = new Map<string, StreamMessage[]>();
let flushScheduled = false;

function scheduleBatchFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(() => {
    flushScheduled = false;
    const shipBatch = new Map(pendingShipLogs);
    const escortBatch = new Map(pendingEscortLogs);
    pendingShipLogs.clear();
    pendingEscortLogs.clear();
    if (shipBatch.size === 0 && escortBatch.size === 0) return;
    useShipStore.setState((state) => {
      const updates: Partial<ShipState> = {};
      if (shipBatch.size > 0) {
        const shipLogs = new Map(state.shipLogs);
        for (const [id, msgs] of shipBatch) {
          const existing = shipLogs.get(id) ?? [];
          shipLogs.set(id, [...existing, ...msgs]);
        }
        updates.shipLogs = shipLogs;
      }
      if (escortBatch.size > 0) {
        const escortLogs = new Map(state.escortLogs);
        for (const [id, msgs] of escortBatch) {
          const existing = escortLogs.get(id) ?? [];
          escortLogs.set(id, [...existing, ...msgs]);
        }
        updates.escortLogs = escortLogs;
      }
      return updates;
    });
  });
}

interface ShipState {
  ships: Map<string, Ship>;
  shipLogs: Map<string, StreamMessage[]>;
  escortLogs: Map<string, StreamMessage[]>;

  addShip: (ship: Partial<Ship> & { id: string; phase: Phase }) => void;
  setShipPhase: (id: string, phase: Phase, extra?: ShipPhaseData) => void;
  setShipCompacting: (id: string, isCompacting: boolean) => void;
  addShipLog: (id: string, message: StreamMessage) => void;
  addEscortLog: (id: string, message: StreamMessage) => void;
  mergeShipHistory: (id: string, messages: StreamMessage[], requestedAt: number) => void;
  mergeEscortHistory: (id: string, messages: StreamMessage[], requestedAt: number) => void;
  setGateCheck: (id: string, gateCheck: GateCheckState) => void;
  clearGateCheck: (id: string) => void;
  setShipDone: (id: string, prUrl?: string, merged?: boolean) => void;

  updateShipFromApi: (shipId: string, knownFleetId?: string) => Promise<void>;
  upsertShip: (ship: Ship) => void;
  removeShip: (id: string) => void;
  fetchShips: (fleetId: string) => Promise<void>;
  sortie: (fleetId: string, repo: string, issueNumber: number) => Promise<void>;
  chatWithShip: (id: string, message: string) => void;
  retryShip: (id: string) => Promise<void>;
  pauseShip: (id: string) => Promise<void>;
  abandonShip: (id: string) => Promise<void>;
  reactivateShip: (id: string) => Promise<void>;
}

export const useShipStore = create<ShipState>((set) => ({
  ships: new Map(),
  shipLogs: new Map(),
  escortLogs: new Map(),

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
    const buf = pendingShipLogs.get(id) ?? [];
    buf.push(message);
    pendingShipLogs.set(id, buf);
    scheduleBatchFlush();
  },

  addEscortLog: (id, message) => {
    const buf = pendingEscortLogs.get(id) ?? [];
    buf.push(message);
    pendingEscortLogs.set(id, buf);
    scheduleBatchFlush();
  },

  mergeShipHistory: (id, messages, requestedAt) => {
    const buffered = pendingShipLogs.get(id) ?? [];
    pendingShipLogs.delete(id);

    set((state) => {
      const shipLogs = new Map(state.shipLogs);
      const existing = shipLogs.get(id) ?? [];

      // Keep buffered/existing messages that arrived after the history was
      // requested (local clock). Messages without a timestamp are streaming
      // fragments that just arrived — always preserve them.
      const newer = [...existing, ...buffered].filter(
        (m) => m.timestamp == null || m.timestamp >= requestedAt,
      );

      shipLogs.set(id, [...messages, ...newer]);
      return { shipLogs };
    });
  },

  mergeEscortHistory: (id, messages, requestedAt) => {
    const buffered = pendingEscortLogs.get(id) ?? [];
    pendingEscortLogs.delete(id);

    set((state) => {
      const escortLogs = new Map(state.escortLogs);
      const existing = escortLogs.get(id) ?? [];

      const newer = [...existing, ...buffered].filter(
        (m) => m.timestamp == null || m.timestamp >= requestedAt,
      );

      escortLogs.set(id, [...messages, ...newer]);
      return { escortLogs };
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


  updateShipFromApi: async (shipId, knownFleetId?) => {
    try {
      const existing = useShipStore.getState().ships.get(shipId);
      const fleetId = knownFleetId ?? existing?.fleetId ?? useFleetStore.getState().selectedFleetId;
      if (!fleetId) {
        console.warn(`[shipStore] updateShipFromApi: Ship ${shipId} — no fleetId available, skipping`);
        return;
      }
      const ship = await api.fetchShip(shipId, fleetId);
      if (ship) {
        useShipStore.getState().upsertShip(ship);
      }
    } catch (err) {
      console.error("[shipStore] updateShipFromApi failed:", err);
    }
  },

  upsertShip: (serverShip) => {
    set((state) => {
      const ships = new Map(state.ships);
      const existing = ships.get(serverShip.id);
      if (existing) {
        ships.set(serverShip.id, {
          ...serverShip,
          isCompacting: existing.isCompacting,
          gateCheck: existing.gateCheck,
        });
      } else {
        ships.set(serverShip.id, serverShip);
      }
      return { ships };
    });
    // Auto-register session (ADR-0023 Decision 4)
    if (serverShip.fleetId && serverShip.issueNumber) {
      useSessionStore.getState().registerSession(
        createShipSession(serverShip.id, serverShip.fleetId, serverShip.issueNumber, serverShip.issueTitle),
      );
    }
  },

  removeShip: (id) => {
    set((state) => {
      const ships = new Map(state.ships);
      ships.delete(id);
      const shipLogs = new Map(state.shipLogs);
      shipLogs.delete(id);
      const escortLogs = new Map(state.escortLogs);
      escortLogs.delete(id);
      return { ships, shipLogs, escortLogs };
    });
    pendingShipLogs.delete(id);
    pendingEscortLogs.delete(id);
  },

  fetchShips: async (fleetId) => {
    try {
      const shipList = await api.fetchShips(fleetId);
      const { upsertShip } = useShipStore.getState();
      for (const ship of shipList) {
        upsertShip(ship);
      }
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
      const ship = useShipStore.getState().ships.get(id);
      if (!ship?.fleetId) throw new Error(`Ship ${id} not found or missing fleetId`);
      await api.resumeShip(id, ship.fleetId);
    } catch (err) {
      console.error("[shipStore] retryShip failed:", err);
    }
  },

  pauseShip: async (id) => {
    try {
      const ship = useShipStore.getState().ships.get(id);
      if (!ship?.fleetId) throw new Error(`Ship ${id} not found or missing fleetId`);
      await api.pauseShip(id, ship.fleetId);
    } catch (err) {
      console.error("[shipStore] pauseShip failed:", err);
    }
  },

  abandonShip: async (id) => {
    try {
      const ship = useShipStore.getState().ships.get(id);
      if (!ship?.fleetId) throw new Error(`Ship ${id} not found or missing fleetId`);
      await api.abandonShip(id, ship.fleetId);
    } catch (err) {
      console.error("[shipStore] abandonShip failed:", err);
    }
  },

  reactivateShip: async (id) => {
    try {
      const ship = useShipStore.getState().ships.get(id);
      if (!ship?.fleetId) throw new Error(`Ship ${id} not found or missing fleetId`);
      await api.reactivateShip(id, ship.fleetId);
    } catch (err) {
      console.error("[shipStore] reactivateShip failed:", err);
    }
  },

}));
