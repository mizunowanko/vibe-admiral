import { useState, useEffect, useCallback, useRef } from "react";
import { wsClient } from "@/lib/ws-client";
import type { ServerMessage, StreamMessage, ImageAttachment } from "@/types";

export function useBridge(fleetId: string | null) {
  const [messages, setMessages] = useState<StreamMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const pendingToolUseId = useRef<string | null>(null);
  const historyLoadedRef = useRef(false);

  useEffect(() => {
    if (!fleetId) {
      setMessages([]);
      setIsLoading(false);
      setPendingQuestion(null);
      pendingToolUseId.current = null;
      historyLoadedRef.current = false;
      return;
    }

    historyLoadedRef.current = false;

    const unsub = wsClient.onMessage((msg: ServerMessage) => {
      if (msg.type === "bridge:stream") {
        const data = msg.data as { fleetId: string; message: StreamMessage };
        if (data.fleetId === fleetId) {
          if (data.message.type === "history") {
            // Only apply history on initial load or reconnect.
            // Skip if we already have live messages to prevent scroll reset.
            if (historyLoadedRef.current) return;
            try {
              const history = JSON.parse(
                data.message.content ?? "[]",
              ) as StreamMessage[];
              setMessages(history);
              historyLoadedRef.current = true;
              // Restore pending question if the last history message is a question
              const last = history[history.length - 1];
              if (last?.type === "question") {
                setPendingQuestion(last.content ?? null);
                pendingToolUseId.current = last.toolUseId ?? null;
              }
            } catch {
              // ignore parse errors
            }
          } else {
            setIsLoading(false);
            setMessages((prev) => [...prev, { ...data.message, timestamp: data.message.timestamp ?? Date.now() }]);
          }
        }
      }

      // Bridge question — AskUserQuestion from Bridge CLI
      if (msg.type === "bridge:question") {
        const data = msg.data as { fleetId: string; message: StreamMessage };
        if (data.fleetId === fleetId) {
          setIsLoading(false);
          setPendingQuestion(data.message.content ?? "Bridge is asking a question");
          pendingToolUseId.current = data.message.toolUseId ?? null;
          setMessages((prev) => [...prev, { ...data.message, timestamp: data.message.timestamp ?? Date.now() }]);
        }
      }

      // Bridge question timeout — clear pending state
      if (msg.type === "bridge:question-timeout") {
        const timeoutData = msg.data as { fleetId: string };
        if (timeoutData.fleetId === fleetId) {
          setPendingQuestion(null);
          pendingToolUseId.current = null;
          setIsLoading(false);
        }
      }

      if (msg.type === "error") {
        const errorData = msg.data as { source: string; message: string };
        if (
          errorData.source === `bridge-${fleetId}` ||
          errorData.source === "bridge:send"
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
    wsClient.send({ type: "bridge:history", data: { fleetId } });

    // Re-fetch history on reconnect only if we haven't loaded yet
    // (Engine may have restarted — but if we already have live messages, skip
    // the full history fetch to avoid scroll position reset)
    const unsubConnect = wsClient.onConnect(() => {
      if (!historyLoadedRef.current) {
        wsClient.send({ type: "bridge:history", data: { fleetId } });
      }
    });

    return () => {
      unsub();
      unsubConnect();
    };
  }, [fleetId]);

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
        type: "bridge:send",
        data: {
          fleetId,
          message,
          ...(images && images.length > 0 ? { images } : {}),
        },
      });
    },
    [fleetId],
  );

  const answerQuestion = useCallback(
    (answer: string) => {
      if (!fleetId) return;
      const toolUseId = pendingToolUseId.current;
      setPendingQuestion(null);
      pendingToolUseId.current = null;
      // Optimistic update: immediately show the answer in chat
      setMessages((prev) => [
        ...prev,
        { type: "user", content: answer, timestamp: Date.now() },
      ]);
      setIsLoading(true);
      wsClient.send({
        type: "bridge:answer",
        data: { fleetId, answer, ...(toolUseId ? { toolUseId } : {}) },
      });
    },
    [fleetId],
  );

  return { messages, sendMessage, answerQuestion, pendingQuestion, isLoading };
}
