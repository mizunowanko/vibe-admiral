// === Ship Status ===
export type ShipStatus =
  | "sortie"
  | "investigating"
  | "planning"
  | "implementing"
  | "testing"
  | "reviewing"
  | "acceptance-test"
  | "merging"
  | "done"
  | "error";

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
  branchName: string;
  worktreePath: string;
  sessionId: string | null;
  prUrl: string | null;
  prReviewStatus: PRReviewStatus | null;
  acceptanceTest: AcceptanceTestRequest | null;
  acceptanceTestApproved: boolean;
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
export interface StreamMessage {
  type: string;
  content?: string;
  tool?: string;
  toolInput?: Record<string, unknown>;
  subtype?: string;
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
  | { request: "pr-review-result"; shipId: string; prNumber: number; verdict: "approve" | "request-changes"; comments?: string };

// === PR Review Request (file-based IPC) ===
export interface PRReviewRequest {
  prNumber: number;
  prUrl: string;
  repo: string;
}

// === PR Review Response (file-based IPC) ===
export interface PRReviewResponse {
  verdict: "approve" | "request-changes";
  comments?: string;
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
  prUrl: string | null;
  prReviewStatus: PRReviewStatus | null;
  acceptanceTest: AcceptanceTestRequest | null;
  acceptanceTestApproved: boolean;
  createdAt: string;
  completedAt?: number;
}
