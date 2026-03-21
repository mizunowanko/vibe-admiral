// === Ship Status ===
export type ShipStatus =
  | "planning"
  | "implementing"
  | "acceptance-test"
  | "merging"
  | "done"
  | "error";

/** Classification of Ship error cause. */
export type ShipErrorType = "rate_limit" | "unknown";

// === Gate ===

/** A transition key in the format "from→to" (using full-width arrow). */
export type GateTransition =
  | "planning→implementing"
  | "implementing→acceptance-test"
  | "acceptance-test→merging";

/** Gate type determines which Dispatch sub-agent or mechanism handles the check. */
export type GateType = "plan-review" | "code-review" | "playwright";

/** Per-gate configuration: true = default type, string = specific type, false = disabled. */
export type GateConfig = boolean | GateType;

/** Fleet-level gate settings. Omitted transitions use defaults. */
export type FleetGateSettings = Partial<Record<GateTransition, GateConfig>>;

/** Default gate types for each transition. */
export const DEFAULT_GATE_TYPES: Record<GateTransition, GateType> = {
  "planning→implementing": "plan-review",
  "implementing→acceptance-test": "code-review",
  "acceptance-test→merging": "playwright",
};

/** Status of a pending gate check. */
export type GateStatus = "pending" | "approved" | "rejected";

/** Gate check state stored on a Ship. */
export interface GateCheckState {
  transition: GateTransition;
  gateType: GateType;
  status: GateStatus;
  feedback?: string;
  requestedAt: string;
  /** ISO timestamp when Bridge acknowledged receipt of the gate check. */
  acknowledgedAt?: string;
  /** ISO timestamp when the last reminder was sent to Bridge. */
  lastRemindedAt?: string;
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
  /** Rule files loaded for both Bridge and Ship sessions (fleet-wide context). */
  sharedRulePaths?: string[];
  /** Rule files loaded only for the Bridge session (e.g. triage policies). */
  bridgeRulePaths?: string[];
  /** Rule files loaded only for Ship sessions (e.g. implementation constraints). */
  shipRulePaths?: string[];
  /** Gate settings: which transition gates are enabled and their types. */
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
  status: ShipStatus;
  isCompacting: boolean;
  branchName: string;
  worktreePath: string;
  sessionId: string | null;
  prUrl: string | null;
  prReviewStatus: PRReviewStatus | null;
  acceptanceTest: AcceptanceTestRequest | null;
  acceptanceTestApproved: boolean;
  gateCheck: GateCheckState | null;
  errorType: ShipErrorType | null;
  retryCount: number;
  createdAt: string;
}

export interface AcceptanceTestRequest {
  url: string;
  checks: string[];
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
  | "bridge-status"
  | "acceptance-test"
  | "request-result"
  | "pr-review-request"
  | "gate-check-request"
  | "lookout-alert"
  | "task-notification"
  | "dispatch-log";

// === Lookout ===
export type LookoutAlertType =
  | "gate-wait-stall"
  | "acceptance-test-stall"
  | "no-output-stall"
  | "excessive-retries";

export interface SystemMessageMeta {
  category: StreamMessageSubtype;
  issueNumber?: number;
  issueTitle?: string;
  transition?: string;
  gateType?: GateType;
  prNumber?: number;
  prUrl?: string;
  url?: string;
  checks?: string[];
  alertType?: LookoutAlertType;
  shipId?: string;
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
export type IssueStatus = "todo" | "doing" | "done";

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
  checksStatus: string;
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

// === Bridge Requests (Engine-only operations) ===
export type BridgeRequest =
  | { request: "sortie"; items: Array<{ repo: string; issueNumber: number; skill?: string }> }
  | { request: "ship-status" }
  | { request: "ship-stop"; shipId: string }
  | { request: "ship-resume"; shipId: string }
  | { request: "pr-review-result"; shipId: string; prNumber: number; verdict: "approve" | "request-changes"; comments?: string }
  | { request: "gate-result"; shipId: string; transition: GateTransition; verdict: "approve" | "reject"; feedback?: string; issueNumber?: number }
  | { request: "gate-ack"; shipId: string; transition: GateTransition; issueNumber?: number };

// === Ship Requests (Ship → Engine via admiral-request) ===
export type ShipRequest =
  | { request: "status-transition"; status: ShipStatus; planCommentUrl?: string; qaRequired?: boolean }
  | { request: "nothing-to-do"; reason: string };

// === Admiral Request (union of Bridge + Ship requests) ===
export type AdmiralRequest = BridgeRequest | ShipRequest;

// === Admiral Request Response (file-based IPC: Ship ← Engine) ===
export interface AdmiralRequestResponse {
  ok: boolean;
  error?: string;
}

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
  status: ShipStatus;
  isCompacting: boolean;
  prUrl: string | null;
  prReviewStatus: PRReviewStatus | null;
  acceptanceTest: AcceptanceTestRequest | null;
  acceptanceTestApproved: boolean;
  gateCheck: GateCheckState | null;
  /** Whether this Ship requires QA (Playwright) gate before merging. Determined by Ship during planning. Defaults to true. */
  qaRequired: boolean;
  errorType: ShipErrorType | null;
  retryCount: number;
  nothingToDo?: boolean;
  nothingToDoReason?: string;
  createdAt: string;
  completedAt?: number;
  /** Timestamp (ms epoch) of last stdout data from Ship process. Used by Lookout. */
  lastOutputAt: number | null;
}

// === Persisted Ship (subset for disk persistence across Engine restarts) ===
export interface PersistedShip {
  id: string;
  fleetId: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  worktreePath: string;
  branchName: string;
  sessionId: string | null;
  status: ShipStatus;
  createdAt: string;
}

// === Persisted Bridge Session (disk persistence across Engine restarts) ===
export interface PersistedBridgeSession {
  fleetId: string;
  sessionId: string | null;
  createdAt: string;
}

// === Gate File IPC (Engine → Ship file message board) ===
export interface GateFileRequest {
  transition: GateTransition;
  gateType: GateType;
  message: string;
}

export interface GateFileResponse {
  approved: boolean;
  feedback?: string;
}
