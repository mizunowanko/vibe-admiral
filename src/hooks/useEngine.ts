import { useEffect } from "react";
import { wsClient } from "@/lib/ws-client";
import { useFleetStore } from "@/stores/fleetStore";
import { useShipStore } from "@/stores/shipStore";
import { useUIStore } from "@/stores/uiStore";
import type { ServerMessage, Fleet, Ship, ShipStatus, StreamMessage } from "@/types";

export function useEngine() {
  const setFleets = useFleetStore((s) => s.setFleets);
  const selectFleet = useFleetStore((s) => s.selectFleet);
  const setMainView = useUIStore((s) => s.setMainView);
  const addShip = useShipStore((s) => s.addShip);
  const setShipStatus = useShipStore((s) => s.setShipStatus);
  const addShipLog = useShipStore((s) => s.addShipLog);
  const setAcceptanceTest = useShipStore((s) => s.setAcceptanceTest);
  const setShipDone = useShipStore((s) => s.setShipDone);
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

        case "ship:data":
          syncShips(msg.data as unknown as Ship[]);
          break;

        case "fleet:created": {
          const created = msg.data as unknown as { id: string; fleets: Fleet[] };
          setFleets(created.fleets);
          selectFleet(created.id);
          setMainView("bridge");
          break;
        }

        case "ship:created": {
          const created = msg.data as {
            id: string;
            fleetId: string;
            repo: string;
            issueNumber: number;
            issueTitle: string;
            status: ShipStatus;
            branchName?: string;
          };
          addShip(created);
          break;
        }

        case "ship:status": {
          const statusData = msg.data as {
            id: string;
            status: ShipStatus;
            detail?: string;
            fleetId?: string;
            repo?: string;
            issueNumber?: number;
            issueTitle?: string;
          };
          setShipStatus(statusData.id, statusData.status, {
            fleetId: statusData.fleetId,
            repo: statusData.repo,
            issueNumber: statusData.issueNumber,
            issueTitle: statusData.issueTitle,
          });
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

        case "ship:acceptance-test": {
          const atData = msg.data as {
            id: string;
            url: string;
            checks: string[];
          };
          setAcceptanceTest(atData.id, {
            url: atData.url,
            checks: atData.checks,
          });
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

        case "bridge:stream":
          // Bridge messages are handled by useBridge hook
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

    // Fetch initial data
    setTimeout(() => {
      if (wsClient.connected) {
        fetchFleets();
        fetchShips();
      }
    }, 500);

    return () => {
      unsub();
      clearInterval(checkConnection);
      wsClient.disconnect();
    };
  }, [
    setFleets,
    selectFleet,
    setMainView,
    addShip,
    setShipStatus,
    addShipLog,
    setAcceptanceTest,
    setShipDone,
    syncShips,
    fetchShips,
    setEngineConnected,
    fetchFleets,
  ]);
}
