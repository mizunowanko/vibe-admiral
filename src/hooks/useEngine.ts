import { useEffect } from "react";
import { wsClient } from "@/lib/ws-client";
import { useFleetStore } from "@/stores/fleetStore";
import { useShipStore } from "@/stores/shipStore";
import { useUIStore } from "@/stores/uiStore";
import type { ServerMessage, Fleet, Ship, Phase, StreamMessage, GatePhase, GateType } from "@/types";

export function useEngine() {
  const setFleets = useFleetStore((s) => s.setFleets);
  const selectFleet = useFleetStore((s) => s.selectFleet);
  const setMainView = useUIStore((s) => s.setMainView);
  const addShip = useShipStore((s) => s.addShip);
  const setShipPhase = useShipStore((s) => s.setShipPhase);
  const setShipCompacting = useShipStore((s) => s.setShipCompacting);
  const addShipLog = useShipStore((s) => s.addShipLog);
  const setShipLogs = useShipStore((s) => s.setShipLogs);
  const setShipDone = useShipStore((s) => s.setShipDone);
  const setGateCheck = useShipStore((s) => s.setGateCheck);
  const clearGateCheck = useShipStore((s) => s.clearGateCheck);
  const syncShips = useShipStore((s) => s.syncShips);
  const fetchShips = useShipStore((s) => s.fetchShips);
  const setEngineConnected = useUIStore((s) => s.setEngineConnected);
  const fetchFleets = useFleetStore((s) => s.fetchFleets);

  useEffect(() => {
    wsClient.connect();

    const checkConnection = setInterval(() => {
      const connected = wsClient.connected;
      if (connected !== useUIStore.getState().engineConnected) {
        setEngineConnected(connected);
      }
    }, 1000);

    const unsub = wsClient.onMessage((msg: ServerMessage) => {
      switch (msg.type) {
        case "fleet:data":
          setFleets(msg.data as unknown as Fleet[]);
          break;

        case "ship:data": {
          const shipList = msg.data as unknown as Ship[];
          syncShips(shipList);
          // Request logs for ships that don't have logs in the store yet
          const currentLogs = useShipStore.getState().shipLogs;
          for (const ship of shipList) {
            if (ship.phase !== "done" && !currentLogs.has(ship.id)) {
              wsClient.send({ type: "ship:logs", data: { id: ship.id } });
            }
          }
          break;
        }

        case "fleet:created": {
          const created = msg.data as unknown as { id: string; fleets: Fleet[] };
          setFleets(created.fleets);
          selectFleet(created.id);
          setMainView("command");
          break;
        }

        case "ship:created": {
          const created = msg.data as {
            id: string;
            fleetId: string;
            repo: string;
            issueNumber: number;
            issueTitle: string;
            phase: Phase;
            branchName?: string;
          };
          addShip(created);
          break;
        }

        case "ship:status": {
          const statusData = msg.data as {
            id: string;
            phase: Phase;
            detail?: string;
            fleetId?: string;
            repo?: string;
            issueNumber?: number;
            issueTitle?: string;
          };
          setShipPhase(statusData.id, statusData.phase, {
            fleetId: statusData.fleetId,
            repo: statusData.repo,
            issueNumber: statusData.issueNumber,
            issueTitle: statusData.issueTitle,
          });
          break;
        }

        case "ship:compacting": {
          const compactData = msg.data as {
            id: string;
            isCompacting: boolean;
          };
          setShipCompacting(compactData.id, compactData.isCompacting);
          break;
        }

        case "ship:stream": {
          const streamData = msg.data as {
            id: string;
            message: StreamMessage;
          };
          addShipLog(streamData.id, streamData.message);
          break;
        }

        case "escort:stream": {
          const escortData = msg.data as {
            id: string;
            escortId: string;
            message: StreamMessage;
          };
          addShipLog(escortData.id, escortData.message);
          break;
        }

        case "ship:history": {
          const historyData = msg.data as {
            id: string;
            messages: StreamMessage[];
          };
          if (historyData.messages.length > 0) {
            setShipLogs(historyData.id, historyData.messages);
          }
          break;
        }

        case "ship:done": {
          const doneData = msg.data as {
            id: string;
            prUrl?: string;
            merged: boolean;
          };
          setShipDone(doneData.id, doneData.prUrl, doneData.merged);
          break;
        }

        case "ship:gate-pending": {
          const gateData = msg.data as {
            id: string;
            gatePhase: GatePhase;
            gateType: GateType;
          };
          setGateCheck(gateData.id, {
            gatePhase: gateData.gatePhase,
            gateType: gateData.gateType,
            status: "pending",
          });
          break;
        }

        case "ship:gate-resolved": {
          const resolvedData = msg.data as {
            id: string;
            gatePhase: GatePhase;
            gateType: GateType;
            approved: boolean;
            feedback?: string;
          };
          if (resolvedData.approved) {
            clearGateCheck(resolvedData.id);
          } else {
            setGateCheck(resolvedData.id, {
              gatePhase: resolvedData.gatePhase,
              gateType: resolvedData.gateType,
              status: "rejected",
              feedback: resolvedData.feedback,
            });
          }
          break;
        }

        case "flagship:stream":
        case "dock:stream":
          // Commander messages are handled by useCommander hook
          break;

        case "issue:data":
          // Issue data handled by specific components
          break;

        case "error": {
          const errorData = msg.data as { source: string; message: string };
          console.error(`Engine error [${errorData.source}]:`, errorData.message);
          break;
        }
      }
    });

    // Fetch data on every connect/reconnect
    const unsubConnect = wsClient.onConnect(() => {
      fetchFleets();
      void fetchShips();
    });

    return () => {
      unsub();
      unsubConnect();
      clearInterval(checkConnection);
      wsClient.disconnect();
    };
  }, [
    setFleets,
    selectFleet,
    setMainView,
    addShip,
    setShipPhase,
    setShipCompacting,
    addShipLog,
    setShipLogs,
    setShipDone,
    setGateCheck,
    clearGateCheck,
    syncShips,
    fetchShips,
    setEngineConnected,
    fetchFleets,
  ]);
}
