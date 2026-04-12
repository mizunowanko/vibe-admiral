import { useMemo } from "react";
import { useCommander } from "./useCommander";
import { useShip } from "./useShip";
import { useSessionStore } from "@/stores/sessionStore";
import type { StreamMessage, ImageAttachment, Session } from "@/types";

interface SessionMessages {
  messages: StreamMessage[];
  sendMessage?: (message: string, images?: ImageAttachment[]) => void;
  isLoading: boolean;
  session: Session | null;
}

const EMPTY_MESSAGES: StreamMessage[] = [];

function mergeSortByTimestamp(a: StreamMessage[], b: StreamMessage[]): StreamMessage[] {
  const result: StreamMessage[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const aMsg = a[i]!;
    const bMsg = b[j]!;
    if ((aMsg.timestamp ?? 0) <= (bMsg.timestamp ?? 0)) {
      result.push(aMsg);
      i++;
    } else {
      result.push(bMsg);
      j++;
    }
  }
  while (i < a.length) result.push(a[i++]!);
  while (j < b.length) result.push(b[j++]!);
  return result;
}

/**
 * Unified hook that provides messages for any session type.
 * For Commander sessions (dock/flagship), delegates to useCommander.
 * For Ship sessions, reads from the ship log store.
 * For Dispatch sessions, reads from the dispatch log store.
 */
export function useSessionMessages(sessionId: string | null): SessionMessages {
  const session = useSessionStore((s) =>
    sessionId ? s.sessions.get(sessionId) ?? null : null,
  );

  const isCommander = session?.type === "dock" || session?.type === "flagship";
  const isDispatch = session?.type === "dispatch";
  const role = isCommander ? (session!.type as "dock" | "flagship") : "flagship";
  const fleetId = isCommander ? session!.fleetId : null;

  const commanderSessionId = isCommander ? sessionId : null;
  const commander = useCommander(commanderSessionId, fleetId, role);

  const shipId = session?.type === "ship" ? session.shipId ?? null : null;
  const { logs, escortLogs } = useShip(shipId);

  // Dispatch logs: extract the dispatch process ID from session ID (format: "dispatch-dispatch-<uuid>")
  const dispatchProcessId = isDispatch ? sessionId!.replace(/^dispatch-/, "") : null;
  const dispatchLogs = useSessionStore((s) =>
    dispatchProcessId ? s.dispatchLogs.get(dispatchProcessId) ?? EMPTY_MESSAGES : EMPTY_MESSAGES,
  );

  return useMemo(() => {
    if (!session) {
      return {
        messages: EMPTY_MESSAGES,
        isLoading: false,
        session: null,
      };
    }

    if (isCommander) {
      return {
        messages: commander.messages,
        sendMessage: commander.sendMessage,
        isLoading: commander.isLoading,
        session,
      };
    }

    if (isDispatch) {
      return {
        messages: dispatchLogs,
        isLoading: false,
        session,
      };
    }

    // Ship session — merge ship and escort logs by timestamp
    const merged = escortLogs.length === 0
      ? logs
      : mergeSortByTimestamp(logs, escortLogs);
    return {
      messages: merged,
      isLoading: false,
      session,
    };
  }, [session, isCommander, isDispatch, commander, logs, escortLogs, dispatchLogs]);
}
