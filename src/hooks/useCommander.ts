import { useState, useEffect, useCallback, useRef } from "react";
import { wsClient } from "@/lib/ws-client";
import type { ServerMessage, StreamMessage, ImageAttachment, CommanderRole } from "@/types";

export function useCommander(fleetId: string | null, role: CommanderRole) {
  const [messages, setMessages] = useState<StreamMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const pendingToolUseId = useRef<string | null>(null);
  const historyLoadedRef = useRef(false);

  const streamType = `${role}:stream` as const;
  const questionType = `${role}:question` as const;
  const questionTimeoutType = `${role}:question-timeout` as const;
  const roleLabel = role === "flagship" ? "Flagship" : "Dock";

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

      // Commander question — AskUserQuestion from CLI
      if (msg.type === questionType) {
        const data = msg.data as { fleetId: string; message: StreamMessage };
        if (data.fleetId === fleetId) {
          setIsLoading(false);
          setPendingQuestion(data.message.content ?? `${roleLabel} is asking a question`);
          pendingToolUseId.current = data.message.toolUseId ?? null;
          setMessages((prev) => [...prev, { ...data.message, timestamp: data.message.timestamp ?? Date.now() }]);
        }
      }

      // Commander question timeout — clear pending state
      if (msg.type === questionTimeoutType) {
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
    wsClient.send({ type: `${role}:history`, data: { fleetId } });

    // Re-fetch history on reconnect only if we haven't loaded yet
    const unsubConnect = wsClient.onConnect(() => {
      if (!historyLoadedRef.current) {
        wsClient.send({ type: `${role}:history`, data: { fleetId } });
      }
    });

    return () => {
      unsub();
      unsubConnect();
    };
  }, [fleetId, role, streamType, questionType, questionTimeoutType, roleLabel]);

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
        type: `${role}:answer`,
        data: { fleetId, answer, ...(toolUseId ? { toolUseId } : {}) },
      });
    },
    [fleetId, role],
  );

  return { messages, sendMessage, answerQuestion, pendingQuestion, isLoading };
}
