import { useState, useEffect, useCallback, useRef } from "react";
import { wsClient } from "@/lib/ws-client";
import type { ServerMessage, StreamMessage, ImageAttachment, CommanderRole } from "@/types";

export function useCommander(fleetId: string | null, role: CommanderRole) {
  const [messages, setMessages] = useState<StreamMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const historyLoadedRef = useRef(false);
  // Track the timestamp when we requested history so we can identify
  // which optimistic messages arrived after the request and must be preserved.
  const historyRequestedAtRef = useRef<number>(0);
  // Track previous fleetId/role to detect actual changes vs. effect re-runs
  const prevFleetRef = useRef<{ fleetId: string | null; role: CommanderRole }>({ fleetId: null, role });

  const streamType = `${role}:stream` as const;

  useEffect(() => {
    if (!fleetId) {
      // Don't clear messages when fleetId becomes null transiently
      // (e.g. during WS reconnection). Preserve existing state so
      // the UI doesn't flash and drafts survive the remount cycle.
      prevFleetRef.current = { fleetId, role };
      return;
    }

    // Only clear messages when fleetId or role actually changed to prevent
    // cross-role leakage. Skip clearing if the effect re-runs with the
    // same values (e.g. due to dependency identity changes from parent re-renders).
    const prev = prevFleetRef.current;
    if ((prev.fleetId && prev.fleetId !== fleetId) || prev.role !== role) {
      setMessages([]);
      setIsLoading(false);
      historyLoadedRef.current = false;
    }
    prevFleetRef.current = { fleetId, role };

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
              // Merge: preserve any optimistic messages (user messages added
              // after the history request) that aren't in the server history.
              const requestedAt = historyRequestedAtRef.current;
              setMessages((prev) => {
                // Collect messages the user added optimistically after we
                // requested history — these won't be in the server payload yet.
                const optimistic = prev.filter(
                  (m) => (m.timestamp ?? 0) >= requestedAt && m.type === "user",
                );
                if (optimistic.length === 0) return history;
                // Deduplicate: if the history already contains a message with
                // the same timestamp+content, skip it.
                const historySet = new Set(
                  history.map((h) => `${h.timestamp}:${h.content}`),
                );
                const unique = optimistic.filter(
                  (m) => !historySet.has(`${m.timestamp}:${m.content}`),
                );
                return unique.length > 0 ? [...history, ...unique] : history;
              });
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
              setIsLoading(false);
            }
            setMessages((prev) => [...prev, { ...data.message, timestamp: data.message.timestamp ?? Date.now() }]);
          }
        }
      }

      if (msg.type === "error") {
        const errorData = msg.data as { source: string; message: string };
        if (
          errorData.source === `${role}-${fleetId}` ||
          errorData.source === `${role}:send`
        ) {
          setIsLoading(false);
          setMessages((prev) => [
            ...prev,
            { type: "error", content: errorData.message, timestamp: Date.now() },
          ]);
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
  }, [fleetId, role, streamType]);

  const sendMessage = useCallback(
    (message: string, images?: ImageAttachment[]) => {
      if (!fleetId) return;
      setMessages((prev) => [
        ...prev,
        {
          type: "user",
          content: message,
          timestamp: Date.now(),
          ...(images && images.length > 0 ? { images } : {}),
        },
      ]);
      setIsLoading(true);
      wsClient.send({
        type: `${role}:send`,
        data: {
          fleetId,
          message,
          ...(images && images.length > 0 ? { images } : {}),
        },
      });
    },
    [fleetId, role],
  );

  return { messages, sendMessage, isLoading };
}
