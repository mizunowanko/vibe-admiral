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
export interface Fleet {
  id: string;
  name: string;
  repos: string[];
  createdAt: string;
}

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
  acceptanceTest: AcceptanceTestRequest | null;
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

// === Bridge Actions ===
export type BridgeAction =
  | { action: "sortie"; requests: Array<{ repo: string; issueNumber: number }> }
  | {
      action: "create-issue";
      repo: string;
      title: string;
      body: string;
      labels?: string[];
      parentIssue?: number;
      dependsOn?: number[];
    }
  | { action: "list-issues"; repo: string; label?: string }
  | { action: "ship-status" };

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
  acceptanceTest: AcceptanceTestRequest | null;
  createdAt: string;
  completedAt?: number;
}
