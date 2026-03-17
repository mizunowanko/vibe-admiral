// === Ship Status ===
export type ShipStatus =
  | "sortie" // 出撃準備中
  | "investigating" // 調査中
  | "planning" // 計画中
  | "implementing" // 実装中
  | "testing" // テスト中
  | "reviewing" // レビュー中
  | "acceptance-test" // 受け入れテスト中
  | "merging" // マージ中
  | "done" // 完了
  | "error"; // エラー

/** Classification of Ship error cause. */
export type ShipErrorType = "rate_limit" | "unknown";

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
  createdAt: string;
}

// === PR Review Status ===
export type PRReviewStatus = "pending" | "approved" | "changes-requested";

// === Gate ===
export type GateTransition =
  | "planning→implementing"
  | "testing→reviewing"
  | "reviewing→acceptance-test"
  | "acceptance-test→merging";

export type GateType = "plan-review" | "code-review" | "playwright" | "human";
export type GateStatus = "pending" | "approved" | "rejected";

export interface GateCheckState {
  transition: GateTransition;
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
  escortAgentId: string | null;
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

// === Stream Message (Claude Code stream-json output) ===
export type StreamMessageSubtype =
  | "ship-status"
  | "compact-status"
  | "bridge-status"
  | "acceptance-test"
  | "request-result"
  | "pr-review-request"
  | "gate-check-request";

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
  | { type: "ship:accept"; data: { id: string } }
  | { type: "ship:reject"; data: { id: string; feedback: string } }
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
      data: { id: string; status: ShipStatus; detail?: string };
    }
  | {
      type: "ship:compacting";
      data: { id: string; isCompacting: boolean };
    }
  | {
      type: "ship:acceptance-test";
      data: { id: string; url: string; checks: string[] };
    }
  | {
      type: "ship:created";
      data: {
        id: string;
        fleetId: string;
        repo: string;
        issueNumber: number;
        issueTitle: string;
        status: ShipStatus;
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
        transition: GateTransition;
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
        transition: GateTransition;
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
  | { type: "error"; data: { source: string; message: string } };
