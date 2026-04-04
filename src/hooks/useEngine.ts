import { useEffect, useMemo } from "react";
import { wsClient } from "@/lib/ws-client";
import { createMessageRegistry } from "@/lib/message-registry";
import type { EnsureExhaustive } from "@/lib/message-registry";
import { useFleetStore } from "@/stores/fleetStore";
import { useShipStore } from "@/stores/shipStore";
import { useUIStore } from "@/stores/uiStore";
import { useAdmiralSettingsStore } from "@/stores/admiralSettingsStore";
import {
  useSessionStore,
  createCommanderSession,
  createShipSession,
  createDispatchSession,
  commanderSessionId,
} from "@/stores/sessionStore";
import type { Fleet, Ship, AdmiralSettings, CaffeinateStatus } from "@/types";

// Compile-time exhaustive check: ensures every ServerMessageType has a handler registered below.
// If a new message type is added to ServerMessage and not handled here, this line will produce
// a type error listing the missing types.
type _HandledTypes =
  | "fleet:data"
  | "ship:data"
  | "fleet:created"
  | "ship:created"
  | "ship:updated"
  | "ship:compacting"
  | "ship:stream"
  | "escort:stream"
  | "escort:completed"
  | "ship:history"
  | "ship:done"
  | "ship:removed"
  | "ship:gate-pending"
  | "ship:gate-resolved"
  | "dispatch:stream"
  | "dispatch:created"
  | "dispatch:completed"
  | "flagship:stream"
  | "flagship:question"
  | "flagship:question-timeout"
  | "dock:stream"
  | "dock:question"
  | "dock:question-timeout"
  | "admiral-settings:data"
  | "issue:data"
  | "fs:dir-listing"
  | "caffeinate:status"
  | "rate-limit:detected"
  | "engine:restarting"
  | "engine:restarted"
  | "engine:previous-crash"
  | "error"
  | "ping";

// This assertion will fail to compile if any ServerMessageType is missing from _HandledTypes.
const _exhaustiveCheck: EnsureExhaustive<_HandledTypes> = true;
void _exhaustiveCheck;

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

  // Build the handler registry once per mount (handlers capture store actions via closure).
  const registry = useMemo(() => {
    const r = createMessageRegistry();
    let rateLimitTimer = 0;

    r.on("fleet:data", (msg) => {
      const fleets = msg.data as Fleet[];
      setFleets(fleets);
      const selectedId = useFleetStore.getState().selectedFleetId;
      if (selectedId) {
        registerSession(createCommanderSession("dock", selectedId));
        registerSession(createCommanderSession("flagship", selectedId));
        const currentFocus = useSessionStore.getState().focusedSessionId;
        if (!currentFocus) {
          setFocus(commanderSessionId("flagship", selectedId), "fleet-change");
        }
      }
    });

    r.on("ship:data", (msg) => {
      const shipList = msg.data as Ship[];
      const currentLogs = useShipStore.getState().shipLogs;
      for (const ship of shipList) {
        upsertShip(ship as Ship);
        registerSession(
          createShipSession(ship.id, ship.fleetId, ship.issueNumber, ship.issueTitle),
        );
        if (ship.phase !== "done" && !currentLogs.has(ship.id)) {
          wsClient.send({ type: "ship:logs", data: { id: ship.id } });
        }
      }
    });

    r.on("fleet:created", (msg) => {
      const created = msg.data as { id: string; fleets: Fleet[] };
      setFleets(created.fleets);
      selectFleet(created.id);
      setMainView("command");
      registerSession(createCommanderSession("dock", created.id));
      registerSession(createCommanderSession("flagship", created.id));
      setFocus(commanderSessionId("flagship", created.id), "fleet-change");
    });

    r.on("ship:created", (msg) => {
      void updateShipFromApi(msg.data.shipId).then(() => {
        const ship = useShipStore.getState().ships.get(msg.data.shipId);
        if (ship) {
          registerSession(
            createShipSession(ship.id, ship.fleetId, ship.issueNumber, ship.issueTitle),
          );
        }
      });
    });

    r.on("ship:updated", (msg) => {
      void updateShipFromApi(msg.data.shipId).then(() => {
        const ship = useShipStore.getState().ships.get(msg.data.shipId);
        if (ship) {
          registerSession(
            createShipSession(ship.id, ship.fleetId, ship.issueNumber, ship.issueTitle),
          );
        }
      });
    });

    r.on("ship:compacting", (msg) => {
      setShipCompacting(msg.data.id, msg.data.isCompacting);
    });

    r.on("ship:stream", (msg) => {
      addShipLog(msg.data.id, msg.data.message);
    });

    r.on("escort:stream", (msg) => {
      addShipLog(msg.data.id, msg.data.message);
    });

    r.on("escort:completed", () => {
      // Handled by useDispatchListener / session updates
    });

    r.on("ship:history", (msg) => {
      if (msg.data.messages.length > 0) {
        mergeShipHistory(msg.data.id, msg.data.messages);
      }
    });

    r.on("ship:done", (msg) => {
      void updateShipFromApi(msg.data.shipId);
    });

    r.on("ship:removed", (msg) => {
      removeShip(msg.data.shipId);
    });

    r.on("ship:gate-pending", (msg) => {
      setGateCheck(msg.data.id, {
        gatePhase: msg.data.gatePhase,
        gateType: msg.data.gateType,
        status: "pending",
      });
    });

    r.on("ship:gate-resolved", (msg) => {
      if (msg.data.approved) {
        clearGateCheck(msg.data.id);
      } else {
        setGateCheck(msg.data.id, {
          gatePhase: msg.data.gatePhase,
          gateType: msg.data.gateType,
          status: "rejected",
          feedback: msg.data.feedback,
        });
      }
    });

    r.on("dispatch:stream", (msg) => {
      const existingSession = useSessionStore.getState().sessions.get(`dispatch-${msg.data.id}`);
      if (!existingSession) {
        const dispatch = useSessionStore.getState().dispatches.get(msg.data.id);
        const dispatchName = dispatch?.name ?? "Dispatch";
        registerSession(
          createDispatchSession(
            msg.data.id,
            msg.data.fleetId,
            dispatchName,
            msg.data.parentRole,
          ),
        );
      }
      // Log routing handled by useDispatchListener
    });

    r.on("dispatch:created", () => {
      // Handled by useDispatchListener
    });

    r.on("dispatch:completed", () => {
      // Handled by useDispatchListener
    });

    // Commander messages are handled by useCommander hook
    r.on("flagship:stream", () => {});
    r.on("flagship:question", () => {});
    r.on("flagship:question-timeout", () => {});
    r.on("dock:stream", () => {});
    r.on("dock:question", () => {});
    r.on("dock:question-timeout", () => {});

    r.on("admiral-settings:data", (msg) => {
      setAdmiralSettings(msg.data as AdmiralSettings);
    });

    r.on("issue:data", () => {
      // Issue data handled by specific components
    });

    r.on("fs:dir-listing", () => {
      // Directory listing handled by specific components
    });

    r.on("caffeinate:status", (msg) => {
      setCaffeinateActive((msg.data as CaffeinateStatus).active);
    });

    r.on("rate-limit:detected", () => {
      setRateLimitActive(true);
      clearTimeout(rateLimitTimer);
      rateLimitTimer = window.setTimeout(() => setRateLimitActive(false), 30_000);
    });

    r.on("engine:restarting", () => {
      setEngineRestarting(true);
    });

    r.on("engine:restarted", () => {
      setEngineRestarting(false);
    });

    r.on("engine:previous-crash", (msg) => {
      console.warn("[engine] Previous crash detected:", msg.data);
      setPreviousCrash(msg.data);
    });

    r.on("error", (msg) => {
      console.error(`Engine error [${msg.data.source}]:`, msg.data.message);
    });

    r.on("ping", () => {
      // Ping is handled by ws-client directly; should not reach here
    });

    return r;
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
    setEngineConnected,
    setEngineRestarting,
    setRateLimitActive,
    setCaffeinateActive,
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
      registry.dispatch(msg);
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
    registry,
    setEngineConnected,
    setEngineRestarting,
    fetchFleets,
    fetchAdmiralSettings,
    fetchShips,
    registerSession,
  ]);
}
