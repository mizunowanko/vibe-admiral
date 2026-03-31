import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Session, SessionType, Dispatch, StreamMessage, CommanderRole, FocusSource } from "@/types";

interface SessionState {
  sessions: Map<string, Session>;
  focusedSessionId: string | null;
  /** Per-session input drafts preserved across component remounts. */
  inputDrafts: Record<string, string>;
  /** Dispatch processes keyed by dispatch ID. */
  dispatches: Map<string, Dispatch>;
  /** Dispatch logs keyed by dispatch process ID. */
  dispatchLogs: Map<string, StreamMessage[]>;
  /** Commander messages keyed by session ID. */
  commanderMessages: Map<string, StreamMessage[]>;
  /** Commander loading state keyed by session ID. */
  commanderLoading: Map<string, boolean>;

  registerSession: (session: Session) => void;
  unregisterSession: (id: string) => void;
  setFocus: (sessionId: string | null, source?: FocusSource) => void;
  setInputDraft: (sessionId: string, value: string) => void;
  addDispatch: (dispatch: Dispatch) => void;
  updateDispatch: (dispatch: Dispatch) => void;
  addDispatchLog: (dispatchId: string, message: StreamMessage) => void;
  addCommanderMessage: (sessionId: string, msg: StreamMessage) => void;
  setCommanderLoading: (sessionId: string, loading: boolean) => void;
  mergeCommanderHistory: (sessionId: string, history: StreamMessage[], requestedAt: number) => void;
  clearCommanderMessages: (sessionId: string) => void;

  /** Get the focused session object. */
  getFocusedSession: () => Session | null;
  /** Get dispatches for a specific fleet. */
  getDispatchesForFleet: (fleetId: string) => Dispatch[];
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

/** Create a Dispatch session object. */
export function createDispatchSession(
  dispatchId: string,
  fleetId: string,
  name: string,
  parentRole: CommanderRole,
): Session {
  return {
    id: `dispatch-${dispatchId}`,
    type: "dispatch",
    fleetId,
    label: name,
    hasInput: false,
    parentSessionId: `${parentRole}-${fleetId}`,
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
      dispatchLogs: new Map(),
      commanderMessages: new Map(),
      commanderLoading: new Map(),

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

      setFocus: (sessionId, _source) => set({ focusedSessionId: sessionId }),

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

      addDispatchLog: (dispatchId, message) => {
        set((state) => {
          const dispatchLogs = new Map(state.dispatchLogs);
          const existing = dispatchLogs.get(dispatchId) ?? [];
          dispatchLogs.set(dispatchId, [...existing, message]);
          return { dispatchLogs };
        });
      },

      addCommanderMessage: (sessionId, msg) => {
        set((state) => {
          const commanderMessages = new Map(state.commanderMessages);
          const existing = commanderMessages.get(sessionId) ?? [];
          commanderMessages.set(sessionId, [...existing, { ...msg, timestamp: msg.timestamp ?? Date.now() }]);
          return { commanderMessages };
        });
      },

      setCommanderLoading: (sessionId, loading) => {
        set((state) => {
          const commanderLoading = new Map(state.commanderLoading);
          commanderLoading.set(sessionId, loading);
          return { commanderLoading };
        });
      },

      mergeCommanderHistory: (sessionId, history, requestedAt) => {
        set((state) => {
          const commanderMessages = new Map(state.commanderMessages);
          const prev = commanderMessages.get(sessionId) ?? [];
          // Preserve optimistic messages added after history was requested
          const optimistic = prev.filter(
            (m) => (m.timestamp ?? 0) >= requestedAt && (m.type === "user" || m.type === "assistant"),
          );
          if (optimistic.length === 0) {
            commanderMessages.set(sessionId, history);
          } else {
            // Deduplicate: skip optimistic messages already in server history
            const historySet = new Set(
              history.map((h) => `${h.timestamp}:${h.content}`),
            );
            const unique = optimistic.filter(
              (m) => !historySet.has(`${m.timestamp}:${m.content}`),
            );
            commanderMessages.set(sessionId, unique.length > 0 ? [...history, ...unique] : history);
          }
          return { commanderMessages };
        });
      },

      clearCommanderMessages: (sessionId) => {
        set((state) => {
          const commanderMessages = new Map(state.commanderMessages);
          commanderMessages.delete(sessionId);
          const commanderLoading = new Map(state.commanderLoading);
          commanderLoading.delete(sessionId);
          return { commanderMessages, commanderLoading };
        });
      },

      getFocusedSession: () => {
        const { sessions, focusedSessionId } = get();
        if (!focusedSessionId) return null;
        return sessions.get(focusedSessionId) ?? null;
      },

      getDispatchesForFleet: (fleetId) => {
        const { dispatches } = get();
        const results: Dispatch[] = [];
        for (const d of dispatches.values()) {
          if (d.fleetId === fleetId) {
            results.push(d);
          }
        }
        return results;
      },

      getDispatchesForSession: (sessionId) => {
        const { dispatches } = get();
        const results: Dispatch[] = [];
        for (const d of dispatches.values()) {
          const parentSessionId = `${d.parentRole}-${d.fleetId}`;
          if (parentSessionId === sessionId) {
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
