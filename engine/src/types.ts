// === Phase ===
// Gate is a phase: plan → plan-gate → coding → coding-gate
// → qa → qa-gate → merging → done
// "error" is a derived state: phase ≠ done && process dead.
export type Phase =
  | "plan"
  | "plan-gate"
  | "coding"
  | "coding-gate"
  | "qa"
  | "qa-gate"
  | "merging"
  | "done"
  | "paused"
  | "abandoned";

/** @deprecated Use Phase instead. Kept as alias for migration compatibility. */
export type ShipStatus = Phase;

/** Ordered list of all phases for forward-only validation. */
export const PHASE_ORDER: readonly Phase[] = [
  "plan",
  "plan-gate",
  "coding",
  "coding-gate",
  "qa",
  "qa-gate",
  "merging",
  "done",
] as const;

/** Gate phases and their associated gate types. */
export type GatePhase = "plan-gate" | "coding-gate" | "qa-gate";

/** Gate type determines which Dispatch sub-agent or mechanism handles the check. */
export type GateType = "plan-review" | "code-review" | "playwright" | "auto-approve";

/** Per-gate configuration: true = default type, string = specific type, false = disabled. */
export type GateConfig = boolean | GateType;

/** Fleet-level gate settings. Omitted gate phases use defaults. */
export type FleetGateSettings = Partial<Record<GatePhase, GateConfig>>;

/** Default gate types for each gate phase. */
export const DEFAULT_GATE_TYPES: Record<GatePhase, GateType> = {
  "plan-gate": "plan-review",
  "coding-gate": "code-review",
  "qa-gate": "playwright",
};

/** The phase that follows each gate phase when approved. */
export const GATE_NEXT_PHASE: Record<GatePhase, Phase> = {
  "plan-gate": "coding",
  "coding-gate": "qa",
  "qa-gate": "merging",
};

/** The phase preceding each gate phase (what triggers the gate). */
export const GATE_PREV_PHASE: Record<GatePhase, Phase> = {
  "plan-gate": "plan",
  "coding-gate": "coding",
  "qa-gate": "qa",
};

/** Check if a phase is a gate phase. */
export function isGatePhase(phase: Phase): phase is GatePhase {
  return phase === "plan-gate" || phase === "coding-gate" || phase === "qa-gate";
}

/** Status of a pending gate check. */
export type GateStatus = "pending" | "approved" | "rejected";

/** Gate check state stored on a Ship. */
export interface GateCheckState {
  gatePhase: GatePhase;
  gateType: GateType;
  status: GateStatus;
  feedback?: string | GateVerdictFeedback;
  requestedAt: string;
}

/** @deprecated Use GatePhase instead. Kept for backward compat in admiral-protocol. */
export type GateTransition = GatePhase;

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
  /** Absolute path to the Admiral repo's skills/ directory. Auto-populated by Engine. */
  admiralSkillsDir?: string;
}

export interface Fleet {
  id: string;
  name: string;
  repos: FleetRepo[];
  skillSources?: FleetSkillSources;
  /** Rule files loaded for Dock, Flagship, and Ship sessions (fleet-wide context). */
  sharedRulePaths?: string[];
  /** Rule files loaded only for the Flagship session (Ship management policies). */
  flagshipRulePaths?: string[];
  /** Rule files loaded only for the Dock session (Issue management policies). */
  dockRulePaths?: string[];
  /** Rule files loaded only for Ship sessions (e.g. implementation constraints). */
  shipRulePaths?: string[];
  /** @deprecated Use flagshipRulePaths instead. Auto-migrated on load. */
  bridgeRulePaths?: string[];
  /** Per-actor custom instructions (system prompts) injected at launch time. */
  customInstructions?: CustomInstructions;
  /** Gate settings: which gate phases are enabled and their types. */
  gates?: FleetGateSettings;
  /** Custom Escort prompts per gate type. Overrides default gate skill behavior. */
  gatePrompts?: Partial<Record<GateType, string>>;
  /** Glob patterns for paths that force qaRequired=true when changed. Passed to Escorts via env var. */
  qaRequiredPaths?: string[];
  /** Maximum number of concurrent Ship sorties per fleet (default: 6). */
  maxConcurrentSorties?: number;
  createdAt: string;
}

// === PR Review Status ===
export type PRReviewStatus = "pending" | "approved" | "changes-requested";

// === Gate Intent (Escort pre-verdict declaration) ===
export interface GateIntent {
  verdict: "approve" | "reject";
  feedback?: string | GateVerdictFeedback;
  declaredAt: string;
}

// === Ship ===
export interface Ship {
  id: string;
  fleetId: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  phase: Phase;
  /** Whether the Ship process is dead (derived: phase ≠ done && process not running). */
  processDead: boolean;
  isCompacting: boolean;
  branchName: string;
  worktreePath: string;
  sessionId: string | null;
  prUrl: string | null;
  prReviewStatus: PRReviewStatus | null;
  gateCheck: GateCheckState | null;
  retryCount: number;
  createdAt: string;
}

// === Issue ===
export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
}

// === Stream Message (re-exported from shared) ===
export type {
  StreamMessage,
  StreamMessageSubtype,
  SystemMessageMeta,
  LookoutAlertType,
  ImageAttachment,
} from "../../shared/message-types.js";

// === Issue Status (GitHub label-based) ===
export type IssueStatus = "ready" | "sortied" | "done";

// === Label Operations ===
export interface LabelOps {
  add?: string;
  remove?: string;
}

// === PR Status ===
export interface PRStatus {
  number: number;
  state: string;
  mergeable: boolean;
  checksStatus: "passed" | "failed" | "pending" | "no-checks";
}

// === Worktree ===
export interface Worktree {
  path: string;
  branch: string;
  head: string;
}

// === WebSocket Messages ===
// ServerMessage discriminated union from shared (single source of truth for outgoing messages).
export type {
  ServerMessage,
  ServerMessageType,
  ServerMessageOf,
} from "../../shared/message-types.js";

/** Incoming client message (JSON-parsed, loose shape). */
export interface ClientMessage {
  type: string;
  data?: Record<string, unknown>;
}

// === Flagship Requests (Ship control operations via Flagship) ===
export type FlagshipRequest =
  | { request: "sortie"; items: Array<{ repo: string; issueNumber: number; skill?: string }> }
  | { request: "ship-status" }
  | { request: "ship-pause"; shipId: string }
  | { request: "ship-resume"; shipId: string }
  | { request: "ship-abandon"; shipId: string }
  | { request: "ship-reactivate"; shipId: string }
  | { request: "ship-delete"; shipId: string }
  | { request: "pr-review-result"; shipId: string; prNumber: number; verdict: "approve" | "request-changes"; comments?: string }
  | { request: "restart" }
;

/** @deprecated Use FlagshipRequest instead. Kept for backward compat. */
export type BridgeRequest = FlagshipRequest;

// === Ship Process Info ===
export interface ShipProcess {
  id: string;
  fleetId: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  worktreePath: string;
  branchName: string;
  sessionId: string | null;
  phase: Phase;
  isCompacting: boolean;
  prUrl: string | null;
  prReviewStatus: PRReviewStatus | null;
  gateCheck: GateCheckState | null;
  /** Whether this Ship requires QA (Playwright) gate before merging. Determined by Ship during planning. Defaults to true. */
  qaRequired: boolean;
  retryCount: number;
  createdAt: string;
  completedAt?: number;
  /** Timestamp (ms epoch) of last stdout data from Ship process. Used by Lookout. */
  lastOutputAt: number | null;
  /** Whether this Ship's process has died without reaching "done". Derived state. */
  processDead?: boolean;
  /** Discriminator: "ship" for regular Ships, "escort" for Escort Ships */
  kind?: "ship" | "escort";
  /** If this is an Escort, the parent Ship's ID */
  parentShipId?: string | null;
}

// === Escort Process Info (separate from Ship) ===
export interface EscortProcess {
  id: string;
  shipId: string;
  sessionId: string | null;
  processPid: number | null;
  phase: string;
  createdAt: string;
  completedAt: string | null;
}

// === Dispatch (Engine-managed independent CLI process) ===
export type DispatchStatus = "running" | "completed" | "failed";

/** Dispatch type determines tool permissions. */
export type DispatchType = "investigate" | "modify";

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

/** Full Dispatch process state tracked by DispatchManager. */
export interface DispatchProcess {
  id: string;
  fleetId: string;
  parentRole: CommanderRole;
  name: string;
  prompt: string;
  type: DispatchType;
  status: DispatchStatus;
  cwd: string;
  startedAt: number;
  completedAt?: number;
  result?: string;
}

// === Commander Role (Dock or Flagship) ===
export type CommanderRole = "dock" | "flagship";

// === Persisted Commander Session (disk persistence across Engine restarts) ===
export interface PersistedCommanderSession {
  fleetId: string;
  role: CommanderRole;
  sessionId: string | null;
  createdAt: string;
}

/** @deprecated Use PersistedCommanderSession instead. */
export type PersistedBridgeSession = PersistedCommanderSession;

// === Heads-Up Notification (Commander-to-Commander) ===
export type HeadsUpSeverity = "info" | "warning" | "urgent";

export interface HeadsUpNotification {
  from: CommanderRole;
  to: CommanderRole;
  fleetId: string;
  summary: string;
  shipId?: string;
  issueNumber?: number;
  severity: HeadsUpSeverity;
  needsInvestigation: boolean;
}

// === Resume All Units (cross-fleet bulk resume) ===
export type ResumeAllUnitType = "ship" | "flagship" | "dock";

export interface ResumeAllUnitResult {
  type: ResumeAllUnitType;
  id: string;
  fleetId: string;
  label: string;
  status: "resumed" | "skipped" | "error";
  reason?: string;
}

// === Structured Gate Feedback (ADR-0018) ===

/** Category of a gate feedback item. */
export type GateFeedbackCategory = "plan" | "code" | "test" | "style" | "security" | "performance";

/** Severity of a gate feedback item. */
export type GateFeedbackSeverity = "blocker" | "warning" | "suggestion";

/** Individual feedback item from a gate review. */
export interface GateFeedbackItem {
  category: GateFeedbackCategory;
  severity: GateFeedbackSeverity;
  message: string;
  file?: string;
  line?: number;
}

/** Structured feedback payload for gate verdicts. */
export interface GateVerdictFeedback {
  summary: string;
  items: GateFeedbackItem[];
  previouslyRejected?: string[];
}

/**
 * Normalize gate verdict feedback to a structured format.
 * Accepts both legacy string feedback and structured feedback objects.
 */
export function normalizeGateFeedback(
  feedback: string | GateVerdictFeedback | undefined,
): GateVerdictFeedback | undefined {
  if (feedback === undefined || feedback === "") return undefined;
  if (typeof feedback === "string") {
    return { summary: feedback, items: [] };
  }
  return feedback;
}
