/**
 * Test helpers for setting Zustand store state directly.
 *
 * Instead of mocking the entire module, we use `setState()` which is
 * available on every Zustand store. This keeps tests close to production
 * behaviour — components subscribe to the real store, we just pre-populate
 * the state.
 */
import { useSessionStore } from "@/stores/sessionStore";
import { useShipStore } from "@/stores/shipStore";
import { useUIStore } from "@/stores/uiStore";
import { useFleetStore } from "@/stores/fleetStore";
import type { Session, Ship, Phase, StreamMessage, Dispatch } from "@/types";

/** Reset all stores to their initial state between tests. */
export function resetAllStores() {
  useSessionStore.setState({
    sessions: new Map(),
    focusedSessionId: null,
    inputDrafts: {},
    dispatches: new Map(),
    dispatchLogs: new Map(),
  });

  useShipStore.setState({
    ships: new Map(),
    shipLogs: new Map(),
  });

  useUIStore.setState({
    mainView: "command",
    sidebarOpen: true,
    engineConnected: true,
    rateLimitActive: false,
    caffeinateActive: false,
    previousCrash: null,
  });

  useFleetStore.setState({
    fleets: [],
    fleetOrder: [],
    selectedFleetId: null,
    selectedFleet: null,
  });
}

/** Seed sessions into the session store. */
export function seedSessions(sessions: Session[]) {
  const map = new Map<string, Session>();
  for (const s of sessions) map.set(s.id, s);
  useSessionStore.setState({ sessions: map });
}

/** Set focused session. */
export function setFocus(sessionId: string | null) {
  useSessionStore.setState({ focusedSessionId: sessionId });
}

/** Seed ships into the ship store. */
export function seedShips(ships: Ship[]) {
  const map = new Map<string, Ship>();
  for (const s of ships) map.set(s.id, s);
  useShipStore.setState({ ships: map });
}

/** Seed ship logs. */
export function seedShipLogs(shipId: string, messages: StreamMessage[]) {
  const shipLogs = new Map(useShipStore.getState().shipLogs);
  shipLogs.set(shipId, messages);
  useShipStore.setState({ shipLogs });
}

/** Seed dispatches. */
export function seedDispatches(dispatches: Dispatch[]) {
  const map = new Map<string, Dispatch>();
  for (const d of dispatches) map.set(d.id, d);
  useSessionStore.setState({ dispatches: map });
}

/** Set input drafts. */
export function seedInputDrafts(drafts: Record<string, string>) {
  useSessionStore.setState({ inputDrafts: drafts });
}

/** Helper to create a minimal Ship object for tests. */
export function makeShip(overrides: Partial<Ship> & { id: string; phase: Phase }): Ship {
  return {
    fleetId: "fleet-1",
    repo: "owner/repo",
    issueNumber: 42,
    issueTitle: "Test issue",
    isCompacting: false,
    branchName: "feature/42-test",
    worktreePath: "/tmp/wt",
    sessionId: null,
    prUrl: null,
    prReviewStatus: null,
    gateCheck: null,
    retryCount: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Helper to create a minimal Session object for tests. */
export function makeSession(overrides: Partial<Session> & { id: string; type: Session["type"] }): Session {
  return {
    fleetId: "fleet-1",
    label: overrides.type === "dock" ? "Dock" : overrides.type === "flagship" ? "Flagship" : `Ship`,
    hasInput: overrides.type === "dock" || overrides.type === "flagship",
    ...overrides,
  };
}

/** Helper to create a StreamMessage for tests. */
export function makeMessage(overrides: Partial<StreamMessage> & { type: StreamMessage["type"] }): StreamMessage {
  return {
    timestamp: Date.now(),
    ...overrides,
  };
}
