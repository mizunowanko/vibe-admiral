/**
 * sessionStore — focus management & session lifecycle tests.
 *
 * Guards against regressions during #778 (Frontend store normalization):
 * - Focus is not reset when a session re-registers with identical data
 * - Focus is cleared when the focused session is unregistered
 * - Input drafts are independent per session
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore, createCommanderSession, createShipSession } from "@/stores/sessionStore";
import { resetAllStores, makeSession, setFocus } from "@/test-utils/store-helpers";

beforeEach(() => {
  resetAllStores();
});

describe("sessionStore focus management", () => {
  it("preserves focus when re-registering an identical session", () => {
    const dock = createCommanderSession("dock", "fleet-1");
    const store = useSessionStore.getState();

    store.registerSession(dock);
    store.setFocus(dock.id);

    // Re-register the exact same session (e.g. WS reconnection)
    store.registerSession({ ...dock });

    expect(useSessionStore.getState().focusedSessionId).toBe(dock.id);
  });

  it("preserves focus when a different session is added", () => {
    const dock = createCommanderSession("dock", "fleet-1");
    const flagship = createCommanderSession("flagship", "fleet-1");
    const store = useSessionStore.getState();

    store.registerSession(dock);
    store.setFocus(dock.id);

    // Adding a new session should not affect existing focus
    store.registerSession(flagship);

    expect(useSessionStore.getState().focusedSessionId).toBe(dock.id);
  });

  it("preserves focus when a Ship session is added", () => {
    const dock = createCommanderSession("dock", "fleet-1");
    const ship = createShipSession("ship-1", "fleet-1", 42, "Fix bug");
    const store = useSessionStore.getState();

    store.registerSession(dock);
    store.setFocus(dock.id);

    store.registerSession(ship);

    expect(useSessionStore.getState().focusedSessionId).toBe(dock.id);
  });

  it("clears focus when focused session is unregistered", () => {
    const dock = createCommanderSession("dock", "fleet-1");
    const store = useSessionStore.getState();

    store.registerSession(dock);
    store.setFocus(dock.id);
    store.unregisterSession(dock.id);

    expect(useSessionStore.getState().focusedSessionId).toBeNull();
  });

  it("does not clear focus when an unfocused session is unregistered", () => {
    const dock = createCommanderSession("dock", "fleet-1");
    const flagship = createCommanderSession("flagship", "fleet-1");
    const store = useSessionStore.getState();

    store.registerSession(dock);
    store.registerSession(flagship);
    store.setFocus(dock.id);

    store.unregisterSession(flagship.id);

    expect(useSessionStore.getState().focusedSessionId).toBe(dock.id);
  });

  it("skips Map recreation when re-registering identical session", () => {
    const dock = createCommanderSession("dock", "fleet-1");
    const store = useSessionStore.getState();

    store.registerSession(dock);
    const sessionsBefore = useSessionStore.getState().sessions;

    // Re-register with identical data — should return same reference
    store.registerSession({ ...dock });
    const sessionsAfter = useSessionStore.getState().sessions;

    expect(sessionsBefore).toBe(sessionsAfter);
  });
});

describe("sessionStore input drafts", () => {
  it("stores drafts independently per session", () => {
    const store = useSessionStore.getState();
    store.setInputDraft("dock-fleet-1", "hello dock");
    store.setInputDraft("flagship-fleet-1", "hello flagship");

    const drafts = useSessionStore.getState().inputDrafts;
    expect(drafts["dock-fleet-1"]).toBe("hello dock");
    expect(drafts["flagship-fleet-1"]).toBe("hello flagship");
  });

  it("preserves other session drafts when updating one", () => {
    const store = useSessionStore.getState();
    store.setInputDraft("dock-fleet-1", "draft A");
    store.setInputDraft("flagship-fleet-1", "draft B");
    store.setInputDraft("dock-fleet-1", "updated A");

    const drafts = useSessionStore.getState().inputDrafts;
    expect(drafts["dock-fleet-1"]).toBe("updated A");
    expect(drafts["flagship-fleet-1"]).toBe("draft B");
  });
});

describe("sessionStore dispatch management", () => {
  it("returns dispatches filtered by fleet", () => {
    const store = useSessionStore.getState();
    store.addDispatch({
      id: "d-1",
      parentRole: "dock",
      fleetId: "fleet-1",
      name: "investigate",
      status: "running",
      startedAt: 1000,
    });
    store.addDispatch({
      id: "d-2",
      parentRole: "flagship",
      fleetId: "fleet-2",
      name: "explore",
      status: "completed",
      startedAt: 2000,
    });

    const fleet1 = store.getDispatchesForFleet("fleet-1");
    expect(fleet1).toHaveLength(1);
    expect(fleet1[0]!.id).toBe("d-1");
  });

  it("returns dispatches filtered by parent session", () => {
    const store = useSessionStore.getState();
    store.addDispatch({
      id: "d-1",
      parentRole: "dock",
      fleetId: "fleet-1",
      name: "investigate",
      status: "running",
      startedAt: 1000,
    });
    store.addDispatch({
      id: "d-2",
      parentRole: "flagship",
      fleetId: "fleet-1",
      name: "explore",
      status: "completed",
      startedAt: 2000,
    });

    const dockDispatches = store.getDispatchesForSession("dock-fleet-1");
    expect(dockDispatches).toHaveLength(1);
    expect(dockDispatches[0]!.id).toBe("d-1");
  });
});
