import { useEffect, useCallback, useRef } from "react";
import { wsClient } from "@/lib/ws-client";
import { useSessionStore } from "@/stores/sessionStore";
import type { ServerMessage, StreamMessage, ImageAttachment, CommanderRole } from "@/types";

const EMPTY_MESSAGES: StreamMessage[] = [];

export function useCommander(sessionId: string | null, fleetId: string | null, role: CommanderRole) {
  const messages = useSessionStore((s) =>
    sessionId ? s.commanderMessages.get(sessionId) ?? EMPTY_MESSAGES : EMPTY_MESSAGES,
  );
  const isLoading = useSessionStore((s) =>
    sessionId ? s.commanderLoading.get(sessionId) ?? false : false,
  );

  const historyLoadedRef = useRef(false);
  // Track the timestamp when we requested history so we can identify
  // which optimistic messages arrived after the request and must be preserved.
  const historyRequestedAtRef = useRef<number>(0);
  // Track previous sessionId to detect actual session changes vs. effect re-runs
  const prevSessionIdRef = useRef<string | null>(null);

  const streamType = `${role}:stream` as const;

  useEffect(() => {
    if (!sessionId || !fleetId) {
      return;
    }

    const {
      addCommanderMessage,
      setCommanderLoading,
      mergeCommanderHistory,
      clearCommanderMessages,
    } = useSessionStore.getState();

    // Only clear messages when sessionId actually changed to prevent
    // cross-session leakage. sessionId encodes both fleetId and role,
    // so a single comparison covers fleet switches and role switches.
    if (prevSessionIdRef.current && prevSessionIdRef.current !== sessionId) {
      clearCommanderMessages(prevSessionIdRef.current);
      historyLoadedRef.current = false;
    }
    prevSessionIdRef.current = sessionId;

    // Guard against stale closures: if the effect has been cleaned up
    // (role/fleet changed), the listener must not process any more messages.
    let active = true;

    const unsub = wsClient.onMessage((msg: ServerMessage) => {
      if (!active) return;
      if (msg.type === streamType) {
        const data = msg.data as { fleetId: string; message: StreamMessage };
        if (data.fleetId === fleetId) {
          if (data.message.type === "history") {
            // Only apply history on initial load or reconnect.
            if (historyLoadedRef.current) return;
            try {
              const history = JSON.parse(
                data.message.content ?? "[]",
              ) as StreamMessage[];
              mergeCommanderHistory(sessionId, history, historyRequestedAtRef.current);
              historyLoadedRef.current = true;
            } catch {
              // ignore parse errors
            }
          } else {
            // Only clear loading state for CLI responses (assistant, tool_use, etc.).
            // Engine-injected system messages (ship-status, request-result, etc.)
            // should not affect loading state to avoid unnecessary re-renders
            // that could disrupt scroll position during sortie.
            if (data.message.type !== "system") {
              setCommanderLoading(sessionId, false);
            }
            addCommanderMessage(sessionId, data.message);
          }
        }
      }

      if (msg.type === "error") {
        const errorData = msg.data as { source: string; message: string };
        if (
          errorData.source === `${role}-${fleetId}` ||
          errorData.source === `${role}:send`
        ) {
          setCommanderLoading(sessionId, false);
          addCommanderMessage(sessionId, {
            type: "error",
            content: errorData.message,
            timestamp: Date.now(),
          });
        }
      }

    });

    // Request history on initial connect
    historyRequestedAtRef.current = Date.now();
    wsClient.send({ type: `${role}:history`, data: { fleetId } });

    // Re-fetch history on reconnect to pick up any messages
    // that arrived while disconnected. The merge logic above
    // preserves any optimistic messages the user already sent.
    const unsubConnect = wsClient.onConnect(() => {
      historyLoadedRef.current = false;
      historyRequestedAtRef.current = Date.now();
      wsClient.send({ type: `${role}:history`, data: { fleetId } });
    });

    return () => {
      active = false;
      unsub();
      unsubConnect();
    };
  }, [sessionId, fleetId, role, streamType]);

  const sendMessage = useCallback(
    (message: string, images?: ImageAttachment[]) => {
      if (!fleetId || !sessionId) return;
      const { addCommanderMessage, setCommanderLoading } = useSessionStore.getState();
      addCommanderMessage(sessionId, {
        type: "user",
        content: message,
        timestamp: Date.now(),
        ...(images && images.length > 0 ? { images } : {}),
      });
      setCommanderLoading(sessionId, true);
      wsClient.send({
        type: `${role}:send`,
        data: {
          fleetId,
          message,
          ...(images && images.length > 0 ? { images } : {}),
        },
      });
    },
    [fleetId, sessionId, role],
  );

  return { messages, sendMessage, isLoading };
}
