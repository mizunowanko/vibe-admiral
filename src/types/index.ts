// === Phase (Ship lifecycle) ===
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
  | "done";

/** @deprecated Use Phase instead. Kept for migration compatibility. */
export type ShipStatus = Phase;

/** Gate phases where Bridge review is required. */
export type GatePhase = "planning-gate" | "implementing-gate" | "acceptance-test-gate";

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
  bridgeRulePaths?: string[];
  shipRulePaths?: string[];
  /** Maximum number of concurrent Ship sorties per fleet (default: 6). */
  maxConcurrentSorties?: number;
  createdAt: string;
}

// === PR Review Status ===
export type PRReviewStatus = "pending" | "approved" | "changes-requested";

// === Gate ===
export type GateType = "plan-review" | "code-review" | "playwright";
export type GateStatus = "pending" | "approved" | "rejected";

export interface GateCheckState {
  gatePhase: GatePhase;
  gateType: GateType;
  status: GateStatus;
  feedback?: string;
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
  nothingToDo?: boolean;
  nothingToDoReason?: string;
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

// === Stream Message (Claude Code stream-json output) ===
export type StreamMessageSubtype =
  | "ship-status"
  | "compact-status"
  | "bridge-status"
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
  gatePhase?: string;
  gateType?: GateType;
  prNumber?: number;
  prUrl?: string;
  url?: string;
  checks?: string[];
  alertType?: LookoutAlertType;
  shipId?: string;
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
  subtype?: StreamMessageSubtype;
  meta?: SystemMessageMeta;
  timestamp?: number;
  toolUseId?: string;
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
        bridgeRulePaths?: string[];
        shipRulePaths?: string[];
        maxConcurrentSorties?: number;
      };
    }
  | { type: "fleet:delete"; data: { id: string } }
  | { type: "bridge:send"; data: { fleetId: string; message: string; images?: ImageAttachment[] } }
  | { type: "bridge:answer"; data: { fleetId: string; answer: string; toolUseId?: string } }
  | { type: "bridge:history"; data: { fleetId: string } }
  | {
      type: "ship:sortie";
      data: { fleetId: string; issueNumber: number; repo: string };
    }
  | { type: "ship:chat"; data: { id: string; message: string } }
  | { type: "ship:retry"; data: { id: string } }
  | { type: "ship:stop"; data: { id: string } }
  | { type: "ship:logs"; data: { id: string; limit?: number } }
  | { type: "ship:list" }
  | { type: "issue:list"; data: { repo: string } }
  | { type: "issue:get"; data: { repo: string; number: number } }
  | { type: "fs:list-dir"; data: { path?: string } };

// === WebSocket Messages: Engine → Frontend ===
export type ServerMessage =
  | {
      type: "bridge:stream";
      data: { fleetId: string; message: StreamMessage };
    }
  | {
      type: "bridge:question";
      data: { fleetId: string; message: StreamMessage };
    }
  | { type: "ship:stream"; data: { id: string; message: StreamMessage } }
  | {
      type: "ship:status";
      data: { id: string; phase: Phase; detail?: string; nothingToDo?: boolean; nothingToDoReason?: string };
    }
  | {
      type: "ship:compacting";
      data: { id: string; isCompacting: boolean };
    }
  | {
      type: "ship:created";
      data: {
        id: string;
        fleetId: string;
        repo: string;
        issueNumber: number;
        issueTitle: string;
        phase: Phase;
        branchName: string;
      };
    }
  | {
      type: "ship:done";
      data: { id: string; prUrl?: string; merged: boolean };
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
  | {
      type: "bridge:question-timeout";
      data: { fleetId: string };
    }
  | { type: "error"; data: { source: string; message: string } };
