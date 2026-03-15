import { useState, useEffect, useCallback } from "react";
import { wsClient } from "@/lib/ws-client";
import type { ServerMessage, StreamMessage } from "@/types";

export function useBridge(fleetId: string | null) {
  const [messages, setMessages] = useState<StreamMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!fleetId) {
      setMessages([]);
      setIsLoading(false);
      return;
    }

    const unsub = wsClient.onMessage((msg: ServerMessage) => {
      if (msg.type === "bridge:stream") {
        const data = msg.data as { fleetId: string; message: StreamMessage };
        if (data.fleetId === fleetId) {
          if (data.message.type === "history") {
            try {
              const history = JSON.parse(
                data.message.content ?? "[]",
              ) as StreamMessage[];
              setMessages(history);
            } catch {
              // ignore parse errors
            }
          } else {
            setIsLoading(false);
            setMessages((prev) => [...prev, data.message]);
          }
        }
      }

      if (msg.type === "error") {
        const errorData = msg.data as { source: string; message: string };
        if (errorData.source === `bridge-${fleetId}`) {
          setIsLoading(false);
          setMessages((prev) => [
            ...prev,
            { type: "error", content: errorData.message },
          ]);
        }
      }
    });

    // Request history
    wsClient.send({ type: "bridge:history", data: { fleetId } });

    return unsub;
  }, [fleetId]);

  const sendMessage = useCallback(
    (message: string) => {
      if (!fleetId) return;
      setMessages((prev) => [
        ...prev,
        { type: "user", content: message },
      ]);
      setIsLoading(true);
      wsClient.send({ type: "bridge:send", data: { fleetId, message } });
    },
    [fleetId],
  );

  return { messages, sendMessage, isLoading };
}
