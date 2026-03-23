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

/**
 * Unified hook that provides messages for any session type.
 * For Commander sessions (dock/flagship), delegates to useCommander.
 * For Ship sessions, reads from the ship log store.
 */
export function useSessionMessages(sessionId: string | null): SessionMessages {
  const session = useSessionStore((s) =>
    sessionId ? s.sessions.get(sessionId) ?? null : null,
  );

  const isCommander = session?.type === "dock" || session?.type === "flagship";
  const role = isCommander ? (session!.type as "dock" | "flagship") : "flagship";
  const fleetId = isCommander ? session!.fleetId : null;

  const commander = useCommander(fleetId, role);

  const shipId = session?.type === "ship" ? session.shipId ?? null : null;
  const { logs } = useShip(shipId);

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

    // Ship session
    return {
      messages: logs,
      isLoading: false,
      session,
    };
  }, [session, isCommander, commander, logs]);
}
