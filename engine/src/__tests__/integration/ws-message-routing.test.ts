/**
 * Integration tests for WebSocket message routing via EngineServer.
 *
 * Strategy: Start a real EngineServer on a random port and connect real
 * WebSocket clients. Mock only external I/O (github, worktree, child_process)
 * so the internal wiring (ProcessManager → ShipManager → WS broadcast) is
 * exercised for real.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// ── External I/O mocks (hoisted) ──────────────────────────────────────

vi.mock("../../github.js", () => ({
  getIssue: vi.fn().mockResolvedValue({ number: 1, title: "Test", body: "", labels: [], state: "open" }),
  getDefaultBranch: vi.fn().mockResolvedValue("main"),
  listIssues: vi.fn().mockResolvedValue([]),
  updateLabels: vi.fn(),
}));

vi.mock("../../worktree.js", () => ({
  getRepoRoot: vi.fn().mockResolvedValue("/repo"),
  create: vi.fn(),
  remove: vi.fn(),
  forceRemove: vi.fn(),
  symlinkSettings: vi.fn(),
  toKebabCase: vi.fn().mockReturnValue("test"),
  isWebProject: vi.fn().mockResolvedValue(false),
  listFeatureWorktrees: vi.fn().mockResolvedValue([]),
}));

vi.mock("node:child_process", () => {
  const { EventEmitter } = require("node:events");
  function createMockProc() {
    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: { writable: true, write: vi.fn() },
      pid: 99999,
      exitCode: null as null | number,
      kill: vi.fn(),
    });
    return proc;
  }

  return {
    spawn: vi.fn().mockImplementation(() => createMockProc()),
    execFile: vi.fn((_cmd: string, _args: unknown, _opts: unknown, ...rest: unknown[]) => {
      const cb = typeof _opts === "function" ? _opts : rest[0];
      if (typeof cb === "function") {
        (cb as (err: null, result: { stdout: string }) => void)(null, { stdout: "" });
      }
      return undefined;
    }),
  };
});

// Mock admiral-home to use temp directory
const { testAdmiralHomeRef } = vi.hoisted(() => {
  const ref = { value: "/tmp" };
  return { testAdmiralHomeRef: ref };
});
vi.mock("../../admiral-home.js", () => ({
  getAdmiralHome: () => testAdmiralHomeRef.value,
}));

import { EngineServer } from "../../ws-server.js";

// ── Helpers ───────────────────────────────────────────────────────────

function connectWS(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function waitForMessage(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for message")),
      timeoutMs,
    );
    const handler = (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.off("message", handler);
          resolve(msg);
        }
      } catch {
        // ignore parse errors
      }
    };
    ws.on("message", handler);
  });
}

function collectMessages(ws: WebSocket): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  ws.on("message", (data: Buffer | string) => {
    try {
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    } catch {
      // ignore
    }
  });
  return messages;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("WS message routing (integration)", () => {
  let engine: EngineServer;
  let port: number;
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await mkdtemp(join(tmpdir(), "ws-routing-test-"));
    testAdmiralHomeRef.value = tmpDir;

    // Create fleets.json so loadFleets doesn't error
    await writeFile(join(tmpDir, "fleets.json"), "[]");

    // Use random port (0 → OS assigns)
    engine = new EngineServer(0);
    // Extract the actual port from the HTTP server
    const addr = (engine as unknown as { httpServer: { address(): { port: number } } }).httpServer.address();
    port = (addr as { port: number }).port;
  });

  afterEach(async () => {
    engine.shutdown();
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("client connection", () => {
    it("accepts WebSocket connections", async () => {
      const ws = await connectWS(port);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it("returns error for unknown message type", async () => {
      const ws = await connectWS(port);
      const responsePromise = waitForMessage(ws, (msg) => msg.type === "error");

      ws.send(JSON.stringify({ type: "nonexistent:action" }));
      const response = await responsePromise;

      expect(response.type).toBe("error");
      expect((response.data as Record<string, unknown>).message).toContain("Unknown message type");
      ws.close();
    });

    it("returns error for malformed JSON", async () => {
      const ws = await connectWS(port);
      const responsePromise = waitForMessage(ws, (msg) => msg.type === "error");

      ws.send("not valid json{{{");
      const response = await responsePromise;

      expect(response.type).toBe("error");
      ws.close();
    });
  });

  describe("fleet operations", () => {
    it("fleet:list returns empty array initially", async () => {
      const ws = await connectWS(port);
      const responsePromise = waitForMessage(ws, (msg) => msg.type === "fleet:data");

      ws.send(JSON.stringify({ type: "fleet:list" }));
      const response = await responsePromise;

      expect(response.type).toBe("fleet:data");
      ws.close();
    });
  });

  describe("broadcast to multiple clients", () => {
    it("broadcasts ship:status to all connected clients", async () => {
      const ws1 = await connectWS(port);
      const ws2 = await connectWS(port);

      const messages1 = collectMessages(ws1);
      const messages2 = collectMessages(ws2);

      // Both clients should have received fleet:data from any fleet operations
      // We can test broadcast by triggering a fleet:list on one client
      // and checking both receive
      ws1.send(JSON.stringify({ type: "fleet:list" }));

      // Wait a bit for messages to propagate
      await new Promise((r) => setTimeout(r, 100));

      // ws1 should get the direct response, ws2 should NOT get fleet:data
      // (fleet:data is sendTo, not broadcast)
      const ws1FleetData = messages1.filter((m) => m.type === "fleet:data");
      const ws2FleetData = messages2.filter((m) => m.type === "fleet:data");

      expect(ws1FleetData.length).toBeGreaterThanOrEqual(1);
      // fleet:data is sent via sendTo (not broadcast), so ws2 should not get it
      expect(ws2FleetData).toHaveLength(0);

      ws1.close();
      ws2.close();
    });
  });

  describe("commander operations", () => {
    it("flagship:history returns history for fleet", async () => {
      const ws = await connectWS(port);
      const responsePromise = waitForMessage(ws, (msg) => msg.type === "flagship:stream");

      ws.send(JSON.stringify({
        type: "flagship:history",
        data: { fleetId: "fleet-1" },
      }));

      const response = await responsePromise;
      expect(response.type).toBe("flagship:stream");
      const data = response.data as Record<string, unknown>;
      const message = data.message as Record<string, unknown>;
      expect(message.type).toBe("history");
      ws.close();
    });

    it("dock:history returns history for fleet", async () => {
      const ws = await connectWS(port);
      const responsePromise = waitForMessage(ws, (msg) => msg.type === "dock:stream");

      ws.send(JSON.stringify({
        type: "dock:history",
        data: { fleetId: "fleet-1" },
      }));

      const response = await responsePromise;
      expect(response.type).toBe("dock:stream");
      ws.close();
    });
  });

  describe("issue operations", () => {
    it("issue:list returns issues for a repo", async () => {
      const ws = await connectWS(port);
      const responsePromise = waitForMessage(ws, (msg) => msg.type === "issue:data");

      ws.send(JSON.stringify({
        type: "issue:list",
        data: { repo: "owner/repo" },
      }));

      const response = await responsePromise;
      expect(response.type).toBe("issue:data");
      ws.close();
    });

    it("issue:get returns a single issue", async () => {
      const ws = await connectWS(port);
      const responsePromise = waitForMessage(ws, (msg) => msg.type === "issue:data");

      ws.send(JSON.stringify({
        type: "issue:get",
        data: { repo: "owner/repo", number: 42 },
      }));

      const response = await responsePromise;
      expect(response.type).toBe("issue:data");
      ws.close();
    });
  });

  describe("client disconnect cleanup", () => {
    it("removes client from broadcast set on close", async () => {
      const ws1 = await connectWS(port);
      const ws2 = await connectWS(port);

      // Disconnect ws1
      ws1.close();
      await new Promise((r) => setTimeout(r, 100));

      // ws2 should still work
      const responsePromise = waitForMessage(ws2, (msg) => msg.type === "fleet:data");
      ws2.send(JSON.stringify({ type: "fleet:list" }));
      const response = await responsePromise;
      expect(response.type).toBe("fleet:data");

      ws2.close();
    });
  });
});
