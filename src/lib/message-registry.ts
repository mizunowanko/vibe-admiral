/**
 * Type-safe message handler registry.
 *
 * Replaces the switch statement in useEngine with a declarative `.on(type, handler)` pattern.
 * TypeScript ensures:
 * 1. Handler payload is correctly narrowed by message type.
 * 2. All message types have registered handlers (exhaustive check at call site).
 */
import type { ServerMessage, ServerMessageType, ServerMessageOf } from "@/types";

/** A handler for a specific message type. The parameter is narrowed to the exact variant. */
type MessageHandler<T extends ServerMessageType> = (msg: ServerMessageOf<T>) => void;

/** Map of message type → handler. */
type HandlerMap = {
  [T in ServerMessageType]?: MessageHandler<T>;
};

/**
 * Create a message handler registry with type-safe `.on()` registration.
 *
 * Usage:
 * ```ts
 * const registry = createMessageRegistry();
 * registry.on("ship:stream", (msg) => {
 *   // msg is narrowed to { type: "ship:stream"; data: { id: string; message: StreamMessage } }
 *   addShipLog(msg.data.id, msg.data.message);
 * });
 * // ...register all handlers...
 * registry.dispatch(serverMessage);
 * ```
 */
export function createMessageRegistry() {
  const handlers: HandlerMap = {};

  return {
    /**
     * Register a handler for a specific message type.
     * TypeScript narrows the handler parameter to the exact message variant.
     */
    on<T extends ServerMessageType>(type: T, handler: MessageHandler<T>) {
      (handlers as Record<string, unknown>)[type] = handler;
    },

    /**
     * Dispatch a message to its registered handler.
     * Returns true if a handler was found and called, false otherwise.
     */
    dispatch(msg: ServerMessage): boolean {
      const handler = (handlers as Record<string, ((msg: ServerMessage) => void) | undefined>)[msg.type];
      if (handler) {
        handler(msg);
        return true;
      }
      return false;
    },
  };
}

/** Type helper: ensure all ServerMessage types are handled. */
export type EnsureExhaustive<
  Registered extends ServerMessageType,
  _Check extends ServerMessageType = Registered,
> = [Exclude<ServerMessageType, Registered>] extends [never]
  ? true
  : { error: "Missing handlers for"; types: Exclude<ServerMessageType, Registered> };
