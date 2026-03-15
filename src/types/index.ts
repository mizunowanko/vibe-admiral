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

// === Fleet ===
export interface FleetRepo {
  localPath: string;
  remote?: string;
}

export interface Fleet {
  id: string;
  name: string;
  repos: FleetRepo[];
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

// === Stream Message (Claude Code stream-json output) ===
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
  subtype?: string;
  timestamp?: number;
}

// === WebSocket Messages: Frontend → Engine ===
export type ClientMessage =
  | { type: "fleet:create"; data: { name: string; repos: FleetRepo[] } }
  | { type: "fleet:list" }
  | { type: "fleet:select"; data: { id: string } }
  | {
      type: "fleet:update";
      data: { id: string; name?: string; repos?: FleetRepo[] };
    }
  | { type: "fleet:delete"; data: { id: string } }
  | { type: "bridge:send"; data: { fleetId: string; message: string } }
  | { type: "bridge:history"; data: { fleetId: string } }
  | {
      type: "ship:sortie";
      data: { fleetId: string; issueNumber: number; repo: string };
    }
  | { type: "ship:chat"; data: { id: string; message: string } }
  | { type: "ship:accept"; data: { id: string } }
  | { type: "ship:reject"; data: { id: string; feedback: string } }
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
  | { type: "ship:stream"; data: { id: string; message: StreamMessage } }
  | {
      type: "ship:status";
      data: { id: string; status: ShipStatus; detail?: string };
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
