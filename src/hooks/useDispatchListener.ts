import { useEffect } from "react";
import { wsClient } from "@/lib/ws-client";
import { useSessionStore } from "@/stores/sessionStore";
import type { ServerMessage, Dispatch } from "@/types";

/**
 * Listens for Dispatch sub-agent events from both Dock and Flagship,
 * regardless of which Commander session is currently focused.
 *
 * Mount this in a component that is always rendered when a fleet is
 * active (e.g. SessionCardList) so dispatch cards stay up-to-date.
 */
export function useDispatchListener(fleetId: string | null) {
  const addDispatch = useSessionStore((s) => s.addDispatch);
  const updateDispatch = useSessionStore((s) => s.updateDispatch);

  useEffect(() => {
    if (!fleetId) return;

    const unsub = wsClient.onMessage((msg: ServerMessage) => {
      // Dock dispatch events
      if (msg.type === "dock:dispatch-started") {
        const data = msg.data as { fleetId: string; dispatch: Dispatch };
        if (data.fleetId === fleetId) {
          addDispatch(data.dispatch);
        }
      }
      if (msg.type === "dock:dispatch-completed") {
        const data = msg.data as { fleetId: string; dispatch: Dispatch };
        if (data.fleetId === fleetId) {
          updateDispatch(data.dispatch);
        }
      }

      // Flagship dispatch events
      if (msg.type === "flagship:dispatch-started") {
        const data = msg.data as { fleetId: string; dispatch: Dispatch };
        if (data.fleetId === fleetId) {
          addDispatch(data.dispatch);
        }
      }
      if (msg.type === "flagship:dispatch-completed") {
        const data = msg.data as { fleetId: string; dispatch: Dispatch };
        if (data.fleetId === fleetId) {
          updateDispatch(data.dispatch);
        }
      }
    });

    return unsub;
  }, [fleetId, addDispatch, updateDispatch]);
}
