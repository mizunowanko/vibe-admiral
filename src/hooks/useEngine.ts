import { useEffect, useMemo } from "react";
import { wsClient } from "@/lib/ws-client";
import { createHandlerMap, dispatchMessage } from "@/hooks/handlers";
import type { HandlerContext } from "@/hooks/handlers";
import { useFleetStore } from "@/stores/fleetStore";
import { useShipStore } from "@/stores/shipStore";
import { useUIStore } from "@/stores/uiStore";
import { useAdmiralSettingsStore } from "@/stores/admiralSettingsStore";
import {
  useSessionStore,
  createShipSession,
} from "@/stores/sessionStore";

export function useEngine() {
  const setFleets = useFleetStore((s) => s.setFleets);
  const selectFleet = useFleetStore((s) => s.selectFleet);
  const setMainView = useUIStore((s) => s.setMainView);
  const setShipCompacting = useShipStore((s) => s.setShipCompacting);
  const addShipLog = useShipStore((s) => s.addShipLog);
  const mergeShipHistory = useShipStore((s) => s.mergeShipHistory);
  const setGateCheck = useShipStore((s) => s.setGateCheck);
  const clearGateCheck = useShipStore((s) => s.clearGateCheck);
  const upsertShip = useShipStore((s) => s.upsertShip);
  const removeShip = useShipStore((s) => s.removeShip);
  const fetchShips = useShipStore((s) => s.fetchShips);
  const updateShipFromApi = useShipStore((s) => s.updateShipFromApi);
  const setEngineConnected = useUIStore((s) => s.setEngineConnected);
  const setRateLimitActive = useUIStore((s) => s.setRateLimitActive);
  const setCaffeinateActive = useUIStore((s) => s.setCaffeinateActive);
  const setEngineRestarting = useUIStore((s) => s.setEngineRestarting);
  const setPreviousCrash = useUIStore((s) => s.setPreviousCrash);
  const fetchFleets = useFleetStore((s) => s.fetchFleets);
  const setAdmiralSettings = useAdmiralSettingsStore((s) => s.setSettings);
  const fetchAdmiralSettings = useAdmiralSettingsStore((s) => s.fetchSettings);
  const registerSession = useSessionStore((s) => s.registerSession);
  const setFocus = useSessionStore((s) => s.setFocus);

  // Build the handler context and map once per mount.
  const { handlers, ctx } = useMemo(() => {
    const handlerCtx: HandlerContext = {
      fleetStore: {
        setFleets,
        selectFleet,
        getState: () => useFleetStore.getState(),
      },
      shipStore: {
        upsertShip,
        updateShipFromApi,
        addShipLog,
        mergeShipHistory,
        setShipCompacting,
        setGateCheck,
        clearGateCheck,
        removeShip,
        getState: () => useShipStore.getState(),
      },
      uiStore: {
        setMainView,
        setRateLimitActive,
        setCaffeinateActive,
        setEngineRestarting,
        setPreviousCrash,
      },
      sessionStore: {
        registerSession,
        setFocus,
        getState: () => useSessionStore.getState(),
      },
      admiralSettingsStore: {
        setSettings: setAdmiralSettings,
      },
      wsClient: {
        send: (msg) => wsClient.send(msg as Parameters<typeof wsClient.send>[0]),
      },
    };

    return { handlers: createHandlerMap(), ctx: handlerCtx };
  }, [
    setFleets,
    selectFleet,
    setMainView,
    setShipCompacting,
    addShipLog,
    mergeShipHistory,
    setGateCheck,
    clearGateCheck,
    upsertShip,
    removeShip,
    updateShipFromApi,
    setRateLimitActive,
    setCaffeinateActive,
    setEngineRestarting,
    setPreviousCrash,
    setAdmiralSettings,
    registerSession,
    setFocus,
  ]);

  useEffect(() => {
    wsClient.connect();

    const checkConnection = setInterval(() => {
      const connected = wsClient.connected;
      if (connected !== useUIStore.getState().engineConnected) {
        setEngineConnected(connected);
      }
    }, 1000);

    const unsub = wsClient.onMessage((msg) => {
      dispatchMessage(msg, handlers, ctx);
    });

    // Fetch data on every connect/reconnect
    const unsubConnect = wsClient.onConnect(() => {
      // Clear restarting state on reconnect (covers case where engine:restarted was missed)
      if (useUIStore.getState().engineRestarting) {
        setEngineRestarting(false);
      }
      fetchFleets();
      fetchAdmiralSettings();
      wsClient.send({ type: "caffeinate:get" });
      // Determine fleetId: use the currently selected fleet, or fall back to
      // the first fleet after fetchFleets completes.
      const resolveFleetId = async (): Promise<string | null> => {
        const existing = useFleetStore.getState().selectedFleetId;
        if (existing) return existing;
        // fetchFleets is already in-flight — wait a tick for it to land
        await new Promise((r) => setTimeout(r, 200));
        const state = useFleetStore.getState();
        return state.selectedFleetId ?? state.fleets[0]?.id ?? null;
      };
      void resolveFleetId().then((fleetId) => {
        if (!fleetId) return;
        return fetchShips(fleetId);
      }).then(() => {
        const ships = useShipStore.getState().ships;
        const currentLogs = useShipStore.getState().shipLogs;
        for (const ship of ships.values()) {
          registerSession(
            createShipSession(ship.id, ship.fleetId, ship.issueNumber, ship.issueTitle),
          );
          if (ship.phase !== "done" && !currentLogs.has(ship.id)) {
            wsClient.send({ type: "ship:logs", data: { id: ship.id } });
          }
        }
      });
    });

    return () => {
      unsub();
      unsubConnect();
      clearInterval(checkConnection);
      wsClient.disconnect();
    };
  }, [
    handlers,
    ctx,
    setEngineConnected,
    setEngineRestarting,
    fetchFleets,
    fetchAdmiralSettings,
    fetchShips,
    registerSession,
  ]);
}
