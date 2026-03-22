import { create } from "zustand";
import type { Session, SessionType } from "@/types";

interface SessionState {
  sessions: Map<string, Session>;
  focusedSessionId: string | null;
  /** Per-session input drafts preserved across component remounts. */
  inputDrafts: Record<string, string>;

  registerSession: (session: Session) => void;
  unregisterSession: (id: string) => void;
  setFocus: (sessionId: string | null) => void;
  setInputDraft: (sessionId: string, value: string) => void;

  /** Get the focused session object. */
  getFocusedSession: () => Session | null;
}

/** Build a deterministic session ID for commander roles. */
export function commanderSessionId(
  role: "dock" | "flagship",
  fleetId: string,
): string {
  return `${role}-${fleetId}`;
}

/** Build a deterministic session ID for ship sessions. */
export function shipSessionId(shipId: string): string {
  return `ship-${shipId}`;
}

/** Create a Commander session object. */
export function createCommanderSession(
  role: "dock" | "flagship",
  fleetId: string,
): Session {
  return {
    id: commanderSessionId(role, fleetId),
    type: role as SessionType,
    fleetId,
    label: role === "flagship" ? "Flagship" : "Dock",
    hasInput: true,
  };
}

/** Create a Ship session object. */
export function createShipSession(
  shipId: string,
  fleetId: string,
  issueNumber: number,
  issueTitle: string,
): Session {
  return {
    id: shipSessionId(shipId),
    type: "ship",
    fleetId,
    label: `Ship #${issueNumber}: ${issueTitle}`,
    hasInput: false,
    shipId,
  };
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: new Map(),
  focusedSessionId: null,
  inputDrafts: {},

  registerSession: (session) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      sessions.set(session.id, session);
      return { sessions };
    });
  },

  unregisterSession: (id) => {
    set((state) => {
      const sessions = new Map(state.sessions);
      sessions.delete(id);
      const focusedSessionId =
        state.focusedSessionId === id ? null : state.focusedSessionId;
      return { sessions, focusedSessionId };
    });
  },

  setFocus: (sessionId) => set({ focusedSessionId: sessionId }),

  setInputDraft: (sessionId, value) =>
    set((s) => ({ inputDrafts: { ...s.inputDrafts, [sessionId]: value } })),

  getFocusedSession: () => {
    const { sessions, focusedSessionId } = get();
    if (!focusedSessionId) return null;
    return sessions.get(focusedSessionId) ?? null;
  },
}));
