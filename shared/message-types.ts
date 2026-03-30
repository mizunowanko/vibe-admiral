/**
 * Shared message types for Engine ↔ Frontend WebSocket communication.
 *
 * This is the single source of truth for all WS message shapes.
 * Both Engine and Frontend import from here.
 */

// Re-usable types needed by message definitions.
// These are intentionally duplicated (not imported) to keep this file dependency-free.
// Domain types (Fleet, Ship, etc.) are imported by consumers, not defined here.

export type CommanderRole = "dock" | "flagship";
export type GatePhase = "plan-gate" | "coding-gate" | "qa-gate";
export type GateType = "plan-review" | "code-review" | "playwright" | "auto-approve";
export type GateStatus = "pending" | "approved" | "rejected";

export type StreamMessageSubtype =
  | "ship-status"
  | "compact-status"
  | "commander-status"
  | "request-result"
  | "pr-review-request"
  | "gate-check-request"
  | "lookout-alert"
  | "task-notification"
  | "dispatch-log"
  | "escort-log"
  | "rate-limit-status"
  | "heads-up";

export type LookoutAlertType =
  | "gate-wait-stall"
  | "no-output-stall"
  | "excessive-retries"
  | "escort-death";

export interface SystemMessageMeta {
  category: StreamMessageSubtype;
  issueNumber?: number;
  issueTitle?: string;
  gatePhase?: string;
  gateType?: GateType;
  prNumber?: number;
  prUrl?: string;
  url?: string;
  checks?: string[];
  alertType?: LookoutAlertType;
  shipId?: string;
  branchName?: string;
}

export interface ImageAttachment {
  base64: string;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

export interface StreamMessage {
  type:
    | "assistant"
    | "user"
    | "system"
    | "result"
    | "error"
    | "tool_use"
    | "tool_result"
    | "history"
    | "question";
  content?: string;
  tool?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  subtype?: StreamMessageSubtype;
  meta?: SystemMessageMeta;
  timestamp?: number;
  images?: ImageAttachment[];
  imageCount?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Domain types referenced by messages (minimal interfaces for message shapes).
// Consumers should import full domain types from their own type files.
// ---------------------------------------------------------------------------

/** Minimal Fleet shape for fleet:data / fleet:created messages. */
export interface FleetData {
  id: string;
  name: string;
}

/** Minimal Ship shape for ship:data messages. */
export interface ShipData {
  id: string;
  fleetId: string;
}

/** Minimal Dispatch shape for dispatch:completed messages. */
export interface DispatchData {
  id: string;
  parentRole: CommanderRole;
  fleetId: string;
  name: string;
  status: string;
  startedAt: number;
  completedAt?: number;
  result?: string;
}

/** Minimal AdmiralSettings shape for admiral-settings:data messages. */
export interface AdmiralSettingsData {
  global: { customInstructions?: unknown; gates?: unknown; gatePrompts?: unknown; qaRequiredPaths?: unknown; maxConcurrentSorties?: unknown };
  template: { customInstructions?: unknown; gates?: unknown; gatePrompts?: unknown; qaRequiredPaths?: unknown; maxConcurrentSorties?: unknown };
  caffeinateEnabled?: boolean;
}

/** Caffeinate process status. */
export interface CaffeinateStatus {
  enabled: boolean;
  active: boolean;
}

// ---------------------------------------------------------------------------
// Server → Client messages (Engine → Frontend)
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { type: "flagship:stream"; data: { fleetId: string; message: StreamMessage } }
  | { type: "flagship:question"; data: { fleetId: string; message: StreamMessage } }
  | { type: "flagship:question-timeout"; data: { fleetId: string } }
  | { type: "dock:stream"; data: { fleetId: string; message: StreamMessage } }
  | { type: "dock:question"; data: { fleetId: string; message: StreamMessage } }
  | { type: "dock:question-timeout"; data: { fleetId: string } }
  | { type: "dispatch:stream"; data: { id: string; fleetId: string; parentRole: CommanderRole; message: StreamMessage } }
  | { type: "dispatch:completed"; data: { fleetId: string; dispatch: DispatchData } }
  | { type: "ship:stream"; data: { id: string; message: StreamMessage } }
  | { type: "escort:stream"; data: { id: string; escortId: string; fleetId?: string; issueNumber?: number; message: StreamMessage } }
  | { type: "escort:completed"; data: { id: string; escortId: string; exitCode: number | null; fleetId?: string; issueNumber?: number } }
  | { type: "ship:history"; data: { id: string; messages: StreamMessage[] } }
  | { type: "ship:updated"; data: { shipId: string } }
  | { type: "ship:compacting"; data: { id: string; isCompacting: boolean } }
  | { type: "ship:created"; data: { shipId: string } }
  | { type: "ship:done"; data: { shipId: string } }
  | { type: "ship:gate-pending"; data: { id: string; gatePhase: GatePhase; gateType: GateType; fleetId: string; issueNumber: number; issueTitle: string } }
  | { type: "ship:gate-resolved"; data: { id: string; gatePhase: GatePhase; gateType: GateType; approved: boolean; feedback?: string } }
  | { type: "ship:data"; data: ShipData[] }
  | { type: "fleet:data"; data: FleetData[] }
  | { type: "fleet:created"; data: { id: string; fleets: FleetData[] } }
  | { type: "admiral-settings:data"; data: AdmiralSettingsData }
  | { type: "issue:data"; data: { repo: string; issues: Array<{ number: number; title: string; body: string; labels: string[]; state: string }> } }
  | { type: "fs:dir-listing"; data: { path: string; entries: Array<{ name: string; isDirectory: boolean }> } }
  | { type: "engine:restarting"; data: Record<string, never> }
  | { type: "engine:restarted"; data: Record<string, never> }
  | { type: "engine:previous-crash"; data: { timestamp: string; context: string; message: string; stack?: string } }
  | { type: "rate-limit:detected"; data: { processId: string } }
  | { type: "caffeinate:status"; data: CaffeinateStatus }
  | { type: "ping" }
  | { type: "error"; data: { source: string; message: string } };

/** Extract the message type string union from ServerMessage. */
export type ServerMessageType = ServerMessage["type"];

/** Extract a specific ServerMessage variant by its type field. */
export type ServerMessageOf<T extends ServerMessageType> = Extract<ServerMessage, { type: T }>;

// ---------------------------------------------------------------------------
// Client → Server messages (Frontend → Engine)
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: "fleet:create"; data: { name: string; repos: Array<{ localPath: string; remote?: string }> } }
  | { type: "fleet:list" }
  | { type: "fleet:select"; data: { id: string } }
  | { type: "fleet:update"; data: { id: string; [key: string]: unknown } }
  | { type: "fleet:delete"; data: { id: string } }
  | { type: "admiral-settings:get" }
  | { type: "admiral-settings:update"; data: { global?: Record<string, unknown>; template?: Record<string, unknown>; caffeinateEnabled?: boolean } }
  | { type: "caffeinate:get" }
  | { type: "flagship:send"; data: { fleetId: string; message: string; images?: ImageAttachment[] } }
  | { type: "flagship:answer"; data: { fleetId: string; answer: string; toolUseId?: string } }
  | { type: "flagship:history"; data: { fleetId: string } }
  | { type: "dock:send"; data: { fleetId: string; message: string; images?: ImageAttachment[] } }
  | { type: "dock:answer"; data: { fleetId: string; answer: string; toolUseId?: string } }
  | { type: "dock:history"; data: { fleetId: string } }
  | { type: "ship:chat"; data: { id: string; message: string } }
  | { type: "ship:logs"; data: { id: string; limit?: number } }
  | { type: "issue:list"; data: { repo: string } }
  | { type: "issue:get"; data: { repo: string; number: number } }
  | { type: "fs:list-dir"; data: { path?: string } }
  | { type: "pong" };

/** Extract the message type string union from ClientMessage. */
export type ClientMessageType = ClientMessage["type"];
