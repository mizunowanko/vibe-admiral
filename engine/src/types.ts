// === Phase ===
// Gate is a phase: planning → planning-gate → implementing → implementing-gate
// → acceptance-test → acceptance-test-gate → merging → done
// "error" is a derived state: phase ≠ done && process dead.
export type Phase =
  | "planning"
  | "planning-gate"
  | "implementing"
  | "implementing-gate"
  | "acceptance-test"
  | "acceptance-test-gate"
  | "merging"
  | "done"
  | "stopped";

/** @deprecated Use Phase instead. Kept as alias for migration compatibility. */
export type ShipStatus = Phase;

/** Ordered list of all phases for forward-only validation. */
export const PHASE_ORDER: readonly Phase[] = [
  "planning",
  "planning-gate",
  "implementing",
  "implementing-gate",
  "acceptance-test",
  "acceptance-test-gate",
  "merging",
  "done",
] as const;

/** Gate phases and their associated gate types. */
export type GatePhase = "planning-gate" | "implementing-gate" | "acceptance-test-gate";

/** Gate type determines which Dispatch sub-agent or mechanism handles the check. */
export type GateType = "plan-review" | "code-review" | "playwright";

/** Per-gate configuration: true = default type, string = specific type, false = disabled. */
export type GateConfig = boolean | GateType;

/** Fleet-level gate settings. Omitted gate phases use defaults. */
export type FleetGateSettings = Partial<Record<GatePhase, GateConfig>>;

/** Default gate types for each gate phase. */
export const DEFAULT_GATE_TYPES: Record<GatePhase, GateType> = {
  "planning-gate": "plan-review",
  "implementing-gate": "code-review",
  "acceptance-test-gate": "playwright",
};

/** The phase that follows each gate phase when approved. */
export const GATE_NEXT_PHASE: Record<GatePhase, Phase> = {
  "planning-gate": "implementing",
  "implementing-gate": "acceptance-test",
  "acceptance-test-gate": "merging",
};

/** The phase preceding each gate phase (what triggers the gate). */
export const GATE_PREV_PHASE: Record<GatePhase, Phase> = {
  "planning-gate": "planning",
  "implementing-gate": "implementing",
  "acceptance-test-gate": "acceptance-test",
};

/** Check if a phase is a gate phase. */
export function isGatePhase(phase: Phase): phase is GatePhase {
  return phase === "planning-gate" || phase === "implementing-gate" || phase === "acceptance-test-gate";
}

/** Status of a pending gate check. */
export type GateStatus = "pending" | "approved" | "rejected";

/** Gate check state stored on a Ship. */
export interface GateCheckState {
  gatePhase: GatePhase;
  gateType: GateType;
  status: GateStatus;
  feedback?: string;
  requestedAt: string;
}

/** @deprecated Use GatePhase instead. Kept for backward compat in admiral-protocol. */
export type GateTransition = GatePhase;

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
  /** Gate settings: which gate phases are enabled and their types. */
  gates?: FleetGateSettings;
  /** Maximum number of concurrent Ship sorties per fleet (default: 6). */
  maxConcurrentSorties?: number;
  createdAt: string;
}

// === PR Review Status ===
export type PRReviewStatus = "pending" | "approved" | "changes-requested";

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

// === Stream Message ===
export type StreamMessageSubtype =
  | "ship-status"
  | "compact-status"
  | "commander-status"
  | "request-result"
  | "pr-review-request"
  | "gate-check-request"
  | "lookout-alert"
  | "task-notification"
  | "dispatch-log";

// === Lookout ===
export type LookoutAlertType =
  | "gate-wait-stall"
  | "no-output-stall"
  | "excessive-retries";

export interface SystemMessageMeta {
  category: StreamMessageSubtype;
  issueNumber?: number;
  issueTitle?: string;
  gatePhase?: GatePhase;
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
  type: string;
  content?: string;
  tool?: string;
  toolInput?: Record<string, unknown>;
  subtype?: StreamMessageSubtype;
  meta?: SystemMessageMeta;
  [key: string]: unknown;
}

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
export interface ClientMessage {
  type: string;
  data?: Record<string, unknown>;
}

export interface ServerMessage {
  type: string;
  data: Record<string, unknown>;
}

// === Flagship Requests (Ship control operations via Flagship) ===
export type FlagshipRequest =
  | { request: "sortie"; items: Array<{ repo: string; issueNumber: number; skill?: string }> }
  | { request: "ship-status" }
  | { request: "ship-stop"; shipId: string }
  | { request: "ship-resume"; shipId: string }
  | { request: "pr-review-result"; shipId: string; prNumber: number; verdict: "approve" | "request-changes"; comments?: string }
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
