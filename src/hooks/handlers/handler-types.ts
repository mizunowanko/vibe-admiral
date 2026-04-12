/**
 * Type definitions for domain-separated WS message handlers.
 *
 * Each handler is a pure function: (msg, ctx) => void.
 * HandlerContext bundles all store actions needed by handlers,
 * enabling dependency injection for unit testing.
 */
import type {
  ServerMessageType,
  ServerMessageOf,
  StreamMessage,
  Fleet,
  Ship,
  Dispatch,
  Session,
  GateCheckState,
  AdmiralSettings,
  FocusSource,
} from "@/types";
import type { PreviousCrashInfo } from "@/stores/uiStore";

// ---------------------------------------------------------------------------
// Handler function type
// ---------------------------------------------------------------------------

/** A handler for a specific WS message type. */
export type MessageHandler<T extends ServerMessageType> = (
  msg: ServerMessageOf<T>,
  ctx: HandlerContext,
) => void;

/**
 * Exhaustive handler map — every ServerMessageType key is required.
 * A missing key produces a compile error, enforcing that new message
 * types always get a handler.
 */
export type MessageHandlerMap = {
  [T in ServerMessageType]: MessageHandler<T>;
};

// ---------------------------------------------------------------------------
// Handler context (dependency injection)
// ---------------------------------------------------------------------------

/** Subset of store actions that handlers need. */
export interface HandlerContext {
  fleetStore: {
    setFleets: (fleets: Fleet[]) => void;
    selectFleet: (id: string | null) => void;
    getState: () => { selectedFleetId: string | null };
  };
  shipStore: {
    upsertShip: (ship: Ship) => void;
    updateShipFromApi: (shipId: string, knownFleetId?: string) => Promise<void>;
    addShipLog: (id: string, message: StreamMessage) => void;
    addEscortLog: (id: string, message: StreamMessage) => void;
    mergeShipHistory: (id: string, messages: StreamMessage[]) => void;
    mergeEscortHistory: (id: string, messages: StreamMessage[]) => void;
    setShipCompacting: (id: string, isCompacting: boolean) => void;
    setGateCheck: (id: string, gateCheck: GateCheckState) => void;
    clearGateCheck: (id: string) => void;
    removeShip: (id: string) => void;
    getState: () => { shipLogs: Map<string, StreamMessage[]>; escortLogs: Map<string, StreamMessage[]>; ships: Map<string, Ship> };
  };
  uiStore: {
    setMainView: (view: "command" | "fleet-settings" | "admiral-settings") => void;
    setRateLimitActive: (active: boolean) => void;
    setCaffeinateActive: (active: boolean) => void;
    setEngineRestarting: (restarting: boolean) => void;
    setPreviousCrash: (crash: PreviousCrashInfo | null) => void;
  };
  sessionStore: {
    registerSession: (session: Session) => void;
    upsertDispatch: (dispatch: Dispatch) => void;
    addDispatchLog: (dispatchId: string, message: StreamMessage) => void;
    setFocus: (sessionId: string | null, source?: FocusSource) => void;
    getState: () => {
      focusedSessionId: string | null;
      sessions: Map<string, Session>;
      dispatches: Map<string, { name?: string }>;
    };
  };
  admiralSettingsStore: {
    setSettings: (settings: AdmiralSettings) => void;
  };
  wsClient: {
    send: (msg: unknown) => void;
  };
}
