/**
 * Handler Registry — exhaustive MessageHandlerMap assembly.
 *
 * The mapped type ensures every ServerMessageType has a handler.
 * Adding a new message type to ServerMessage without a handler
 * produces a compile error here.
 */
import type { MessageHandlerMap, HandlerContext } from "./handler-types";

import { handleFleetData, handleFleetCreated } from "./fleet-handlers";
import {
  handleShipData,
  handleShipCreated,
  handleShipUpdated,
  handleShipCompacting,
  handleShipStream,
  handleShipHistory,
  handleShipDone,
  handleShipRemoved,
  handleShipGatePending,
  handleShipGateResolved,
} from "./ship-handlers";
import {
  handleDispatchStream,
  handleDispatchCreated,
  handleDispatchCompleted,
} from "./dispatch-handlers";
import { handleEscortStream, handleEscortCompleted } from "./escort-handlers";
import {
  handleAdmiralSettingsData,
  handleCaffeinateStatus,
  handleRateLimitDetected,
  handleEngineRestarting,
  handleEngineRestarted,
  handleEnginePreviousCrash,
  handleError,
  handlePing,
} from "./engine-handlers";
import {
  handleFlagshipStream,
  handleFlagshipQuestion,
  handleFlagshipQuestionTimeout,
  handleDockStream,
  handleDockQuestion,
  handleDockQuestionTimeout,
  handleIssueData,
  handleFsDirListing,
} from "./noop-handlers";

import type { ServerMessage } from "@/types";

/**
 * Build the exhaustive handler map.
 *
 * The return type `MessageHandlerMap` is `{ [T in ServerMessageType]: MessageHandler<T> }`.
 * TypeScript will error if any key is missing.
 */
export function createHandlerMap(): MessageHandlerMap {
  return {
    // Fleet
    "fleet:data": handleFleetData,
    "fleet:created": handleFleetCreated,

    // Ship
    "ship:data": handleShipData,
    "ship:created": handleShipCreated,
    "ship:updated": handleShipUpdated,
    "ship:compacting": handleShipCompacting,
    "ship:stream": handleShipStream,
    "ship:history": handleShipHistory,
    "ship:done": handleShipDone,
    "ship:removed": handleShipRemoved,
    "ship:gate-pending": handleShipGatePending,
    "ship:gate-resolved": handleShipGateResolved,

    // Dispatch
    "dispatch:stream": handleDispatchStream,
    "dispatch:created": handleDispatchCreated,
    "dispatch:completed": handleDispatchCompleted,

    // Escort
    "escort:stream": handleEscortStream,
    "escort:completed": handleEscortCompleted,

    // Engine / settings
    "admiral-settings:data": handleAdmiralSettingsData,
    "caffeinate:status": handleCaffeinateStatus,
    "rate-limit:detected": handleRateLimitDetected,
    "engine:restarting": handleEngineRestarting,
    "engine:restarted": handleEngineRestarted,
    "engine:previous-crash": handleEnginePreviousCrash,
    error: handleError,
    ping: handlePing,

    // No-op (handled by other hooks / components)
    "flagship:stream": handleFlagshipStream,
    "flagship:question": handleFlagshipQuestion,
    "flagship:question-timeout": handleFlagshipQuestionTimeout,
    "dock:stream": handleDockStream,
    "dock:question": handleDockQuestion,
    "dock:question-timeout": handleDockQuestionTimeout,
    "issue:data": handleIssueData,
    "fs:dir-listing": handleFsDirListing,
  };
}

/**
 * Dispatch a server message to its handler.
 *
 * Uses an unsafe cast internally because TypeScript cannot narrow through
 * indexed access on a union discriminant. The exhaustive `MessageHandlerMap`
 * guarantees that every type has a handler at compile time.
 */
export function dispatchMessage(
  msg: ServerMessage,
  handlers: MessageHandlerMap,
  ctx: HandlerContext,
): void {
  const handler = handlers[msg.type] as (
    msg: ServerMessage,
    ctx: HandlerContext,
  ) => void;
  handler(msg, ctx);
}

export type { MessageHandlerMap, HandlerContext, MessageHandler } from "./handler-types";
