import { useEffect } from "react";
import { wsClient } from "@/lib/ws-client";
import { useSessionStore } from "@/stores/sessionStore";
import type { ServerMessage, Dispatch, StreamMessage, CommanderRole } from "@/types";

/**
 * Listens for Dispatch events from Engine-managed independent processes.
 * Handles dispatch:created, dispatch:stream (log messages), and dispatch:completed events.
 *
 * Mount this in a component that is always rendered when a fleet is
 * active (e.g. SessionCardList) so dispatch cards and logs stay up-to-date.
 */
export function useDispatchListener(fleetId: string | null) {
  const addDispatch = useSessionStore((s) => s.addDispatch);
  const updateDispatch = useSessionStore((s) => s.updateDispatch);
  const addDispatchLog = useSessionStore((s) => s.addDispatchLog);
  const registerSession = useSessionStore((s) => s.registerSession);

  useEffect(() => {
    if (!fleetId) return;

    const unsub = wsClient.onMessage((msg: ServerMessage) => {
      // Dispatch created: register new dispatch card immediately
      if (msg.type === "dispatch:created") {
        const data = msg.data as { fleetId: string; dispatch: Dispatch };
        if (data.fleetId === fleetId) {
          addDispatch(data.dispatch);
        }
      }

      // Dispatch stream: log messages from independent CLI process
      if (msg.type === "dispatch:stream") {
        const data = msg.data as {
          id: string;
          fleetId: string;
          parentRole: CommanderRole;
          message: StreamMessage;
        };
        if (data.fleetId === fleetId) {
          addDispatchLog(data.id, data.message);
        }
      }

      // Dispatch completed: process exited
      if (msg.type === "dispatch:completed") {
        const data = msg.data as { fleetId: string; dispatch: Dispatch };
        if (data.fleetId === fleetId) {
          updateDispatch(data.dispatch);
        }
      }
    });

    return unsub;
  }, [fleetId, addDispatch, updateDispatch, addDispatchLog, registerSession]);
}
