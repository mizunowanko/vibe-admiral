// Phase definitions re-exported from the single source of truth.
// See shared-phases.ts for the canonical definitions.
import type { Phase as _Phase, GatePhase as _GatePhase } from "./shared-phases";
export type Phase = _Phase;
export type GatePhase = _GatePhase;
export { PHASE_ORDER, isGatePhase } from "./shared-phases";

/** @deprecated Use Phase instead. Kept for migration compatibility. */
export type ShipStatus = Phase;

// === Custom Instructions ===
/** Per-actor custom instructions injected via --append-system-prompt. */
export interface CustomInstructions {
  /** Instructions shared across all actors (Dock, Flagship, Ship, Escort). */
  shared?: string;
  /** Instructions specific to the Dock commander. */
  dock?: string;
  /** Instructions specific to the Flagship commander. */
  flagship?: string;
  /** Instructions specific to Ship sessions. */
  ship?: string;
  /** Instructions specific to Escort sessions. */
  escort?: string;
}

// === Fleet ===
export interface FleetRepo {
  localPath: string;
  remote?: string;
}

export interface FleetSkillSources {
  implement?: string;
  devSharedDir?: string;
}

export interface Fleet {
  id: string;
  name: string;
  repos: FleetRepo[];
  skillSources?: FleetSkillSources;
  sharedRulePaths?: string[];
  flagshipRulePaths?: string[];
  dockRulePaths?: string[];
  /** @deprecated Use flagshipRulePaths instead. */
  bridgeRulePaths?: string[];
  shipRulePaths?: string[];
  /** Per-actor custom instructions (system prompts) injected at launch time. */
  customInstructions?: CustomInstructions;
  /** Custom Escort prompts per gate type. Overrides default gate skill behavior. */
  gatePrompts?: Partial<Record<GateType, string>>;
  /** Glob patterns for paths that force qaRequired=true when changed. Passed to Escorts via env var. */
  qaRequiredPaths?: string[];
  /** Maximum number of concurrent Ship sorties per fleet (default: 6). */
  maxConcurrentSorties?: number;
  /** Gate settings: which gate phases are enabled and their types. */
  gates?: FleetGateSettings;
  createdAt: string;
}

// === Commander (Dock/Flagship shared role type) ===
export type CommanderRole = "dock" | "flagship";

// === Session ===
export type SessionType = "dock" | "flagship" | "ship" | "dispatch";

export interface Session {
  id: string;
  type: SessionType;
  fleetId: string;
  label: string;
  hasInput: boolean;
  /** Ship ID for ship sessions (same as session id suffix). */
  shipId?: string;
  /** Parent session ID for dispatch sub-agents. */
  parentSessionId?: string;
}

// === PR Review Status ===
export type PRReviewStatus = "pending" | "approved" | "changes-requested";

// === Gate ===
export type GateType = "plan-review" | "code-review" | "playwright" | "auto-approve";
export type GateStatus = "pending" | "approved" | "rejected";

/** Per-gate configuration: true = default type, false = disabled, or a specific GateType. */
export type GateConfig = boolean | GateType;

/** Fleet-level gate settings. Omitted gate phases use defaults. */
export type FleetGateSettings = Partial<Record<GatePhase, GateConfig>>;

export interface GateCheckState {
  gatePhase: GatePhase;
  gateType: GateType;
  status: GateStatus;
  feedback?: string;
}

// === Escort Info (attached to parent Ship by API) ===
export interface EscortInfo {
  id: string;
  phase: string;
  processDead: boolean;
}

// === Ship ===
export interface Ship {
  id: string;
  fleetId: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  phase: Phase;
  /** Whether the Ship process has died (derived: phase ≠ done && process not running). */
  processDead?: boolean;
  isCompacting: boolean;
  branchName: string;
  worktreePath: string;
  sessionId: string | null;
  prUrl: string | null;
  prReviewStatus: PRReviewStatus | null;
  gateCheck: GateCheckState | null;
  retryCount: number;
  createdAt: string;
  /** Escort information attached by the API (only present when escorts exist). */
  escorts?: EscortInfo[];
}

// === Dispatch (Engine-managed independent CLI process) ===
export type DispatchStatus = "running" | "completed" | "failed";

export interface Dispatch {
  id: string;
  parentRole: CommanderRole;
  fleetId: string;
  name: string;
  status: DispatchStatus;
  startedAt: number;
  completedAt?: number;
  result?: string;
}

/** Build a deterministic session ID for dispatch sessions. */
export function dispatchSessionId(dispatchId: string): string {
  return `dispatch-${dispatchId}`;
}

// === Issue ===
export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
}

// === Stream Message (Claude Code stream-json output) ===
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
  | "rate-limit-status";

// === Lookout ===
export type LookoutAlertType =
  | "gate-wait-stall"
  | "no-output-stall"
  | "excessive-retries";

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

export interface StreamMessage {
  type:
    | "assistant"
    | "user"
    | "system"
    | "result"
    | "error"
    | "tool_use"
    | "tool_result"
    | "history";
  content?: string;
  tool?: string;
  toolInput?: Record<string, unknown>;
  subtype?: StreamMessageSubtype;
  meta?: SystemMessageMeta;
  timestamp?: number;
  images?: ImageAttachment[];
  imageCount?: number;
}

// === Image Attachment ===
export interface ImageAttachment {
  base64: string;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

// === WebSocket Messages: Frontend → Engine ===
export type ClientMessage =
  | { type: "fleet:create"; data: { name: string; repos: FleetRepo[] } }
  | { type: "fleet:list" }
  | { type: "fleet:select"; data: { id: string } }
  | {
      type: "fleet:update";
      data: {
        id: string;
        name?: string;
        repos?: FleetRepo[];
        skillSources?: FleetSkillSources;
        sharedRulePaths?: string[];
        flagshipRulePaths?: string[];
        dockRulePaths?: string[];
        shipRulePaths?: string[];
        customInstructions?: CustomInstructions;
        maxConcurrentSorties?: number;
        gates?: FleetGateSettings;
      };
    }
  | { type: "fleet:delete"; data: { id: string } }
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
  | { type: "fs:list-dir"; data: { path?: string } };

// === WebSocket Messages: Engine → Frontend ===
export type ServerMessage =
  | {
      type: "flagship:stream";
      data: { fleetId: string; message: StreamMessage };
    }
  | {
      type: "flagship:question";
      data: { fleetId: string; message: StreamMessage };
    }
  | {
      type: "flagship:question-timeout";
      data: { fleetId: string };
    }
  | {
      type: "dock:stream";
      data: { fleetId: string; message: StreamMessage };
    }
  | {
      type: "dock:question";
      data: { fleetId: string; message: StreamMessage };
    }
  | {
      type: "dock:question-timeout";
      data: { fleetId: string };
    }
  | {
      type: "dispatch:stream";
      data: {
        id: string;
        fleetId: string;
        parentRole: CommanderRole;
        message: StreamMessage;
      };
    }
  | {
      type: "dispatch:completed";
      data: { fleetId: string; dispatch: Dispatch };
    }
  | { type: "ship:stream"; data: { id: string; message: StreamMessage } }
  | {
      type: "escort:stream";
      data: {
        id: string;
        escortId: string;
        fleetId?: string;
        issueNumber?: number;
        message: StreamMessage;
      };
    }
  | { type: "ship:history"; data: { id: string; messages: StreamMessage[] } }
  | {
      type: "ship:updated";
      data: { shipId: string };
    }
  | {
      type: "ship:compacting";
      data: { id: string; isCompacting: boolean };
    }
  | {
      type: "ship:created";
      data: { shipId: string };
    }
  | {
      type: "ship:done";
      data: { shipId: string };
    }
  | {
      type: "ship:gate-pending";
      data: {
        id: string;
        gatePhase: GatePhase;
        gateType: GateType;
        fleetId: string;
        issueNumber: number;
        issueTitle: string;
      };
    }
  | {
      type: "ship:gate-resolved";
      data: {
        id: string;
        gatePhase: GatePhase;
        gateType: GateType;
        approved: boolean;
        feedback?: string;
      };
    }
  | { type: "ship:data"; data: Ship[] }
  | { type: "fleet:data"; data: Fleet[] }
  | { type: "fleet:created"; data: { id: string; fleets: Fleet[] } }
  | { type: "issue:data"; data: { repo: string; issues: Issue[] } }
  | {
      type: "fs:dir-listing";
      data: {
        path: string;
        entries: Array<{ name: string; isDirectory: boolean }>;
      };
    }
  | { type: "engine:restarting"; data: Record<string, never> }
  | { type: "engine:restarted"; data: Record<string, never> }
  | { type: "rate-limit:detected"; data: { processId: string } }
  | { type: "error"; data: { source: string; message: string } };
