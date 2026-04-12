// Phase definitions re-exported from the single source of truth.
// See shared-phases.ts for the canonical definitions.
import type { Phase as _Phase, GatePhase as _GatePhase } from "./shared-phases";
export type Phase = _Phase;
export type GatePhase = _GatePhase;
export { PHASE_ORDER, isGatePhase } from "./shared-phases";

// Message types from shared (single source of truth for Engine ↔ Frontend).
import type {
  ImageAttachment as _ImageAttachment,
  CaffeinateStatus as _CaffeinateStatus,
} from "@shared/message-types";
export type ImageAttachment = _ImageAttachment;
export type CaffeinateStatus = _CaffeinateStatus;
export type {
  ServerMessage,
  ServerMessageType,
  ServerMessageOf,
  StreamMessage,
  StreamMessageSubtype,
  SystemMessageMeta,
  LookoutAlertType,
  AlertSeverity,
} from "@shared/message-types";

/** @deprecated Use Phase instead. Kept for migration compatibility. */
export type ShipStatus = Phase;

// === Admiral Settings (3-layer configuration) ===
/**
 * Settings fields that participate in the 3-layer merge:
 * Admiral Global → (Fleet Template at creation) → Fleet Per-Fleet
 */
export interface SettingsLayer {
  customInstructions?: CustomInstructions;
  gates?: FleetGateSettings;
  gatePrompts?: Partial<Record<GateType, string>>;
  qaRequiredPaths?: string[];
  maxConcurrentSorties?: number;
}

/** Admiral-level settings: global (runtime merge) + template (creation-time snapshot). */
export interface AdmiralSettings {
  /** Settings applied to ALL fleets at runtime via deepMerge. */
  global: SettingsLayer;
  /** Template copied into new fleets at creation time. Does NOT affect existing fleets. */
  template: SettingsLayer;
  /** Whether to inhibit macOS sleep while Units are active. Default: true. */
  caffeinateEnabled?: boolean;
}

// CaffeinateStatus is now re-exported from @shared/message-types above.

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
  /** Whether user acceptance testing (qa-gate) is required. Default: true. When false, qa-gate Escort auto-approves. */
  acceptanceTestRequired?: boolean;
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

// === Focus Source ===
export type FocusSource =
  | "user-click"
  | "keyboard-shortcut"
  | "fleet-change"
  | "session-created";

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
  parentSessionId?: string;
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

// StreamMessage, StreamMessageSubtype, SystemMessageMeta, ImageAttachment
// are now re-exported from @shared/message-types above.

// === WebSocket Messages: Frontend → Engine ===
// ClientMessage stays local because it references domain types (FleetRepo, etc.).
// ServerMessage is re-exported from @shared/message-types above.
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
  | { type: "admiral-settings:get" }
  | { type: "admiral-settings:update"; data: { global?: SettingsLayer; template?: SettingsLayer; caffeinateEnabled?: boolean } }
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
