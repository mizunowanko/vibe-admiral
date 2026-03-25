import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Session, SessionType, Dispatch } from "@/types";

interface SessionState {
  sessions: Map<string, Session>;
  focusedSessionId: string | null;
  /** Per-session input drafts preserved across component remounts. */
  inputDrafts: Record<string, string>;
  /** Dispatch sub-agents keyed by dispatch ID, grouped per commander session. */
  dispatches: Map<string, Dispatch>;

  registerSession: (session: Session) => void;
  unregisterSession: (id: string) => void;
  setFocus: (sessionId: string | null) => void;
  setInputDraft: (sessionId: string, value: string) => void;
  addDispatch: (dispatch: Dispatch) => void;
  updateDispatch: (dispatch: Dispatch) => void;

  /** Get the focused session object. */
  getFocusedSession: () => Session | null;
  /** Get dispatches for a specific commander session. */
  getDispatchesForSession: (sessionId: string) => Dispatch[];
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

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      sessions: new Map(),
      focusedSessionId: null,
      inputDrafts: {},
      dispatches: new Map(),

      registerSession: (session) => {
        set((state) => {
          const existing = state.sessions.get(session.id);
          if (
            existing &&
            existing.type === session.type &&
            existing.fleetId === session.fleetId &&
            existing.label === session.label &&
            existing.hasInput === session.hasInput &&
            existing.shipId === session.shipId
          ) {
            return state; // No change — skip Map recreation
          }
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

      addDispatch: (dispatch) => {
        set((state) => {
          const dispatches = new Map(state.dispatches);
          dispatches.set(dispatch.id, dispatch);
          return { dispatches };
        });
      },

      updateDispatch: (dispatch) => {
        set((state) => {
          const dispatches = new Map(state.dispatches);
          dispatches.set(dispatch.id, dispatch);
          return { dispatches };
        });
      },

      getFocusedSession: () => {
        const { sessions, focusedSessionId } = get();
        if (!focusedSessionId) return null;
        return sessions.get(focusedSessionId) ?? null;
      },

      getDispatchesForSession: (sessionId) => {
        const { dispatches } = get();
        const results: Dispatch[] = [];
        for (const d of dispatches.values()) {
          const dispatchSessionId = `${d.parentRole}-${d.fleetId}`;
          if (dispatchSessionId === sessionId) {
            results.push(d);
          }
        }
        return results;
      },
    }),
    {
      name: "admiral-session",
      partialize: (state) => ({ inputDrafts: state.inputDrafts }),
    },
  ),
);
