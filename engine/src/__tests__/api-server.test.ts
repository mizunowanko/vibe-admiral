import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createApiHandler } from "../api-server.js";
import type { FleetRepo } from "../types.js";
import type { FlagshipRequestHandler } from "../bridge-request-handler.js";

// === Mock deps ===

function createMockDeps() {
  const handle = vi.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue("");

  return {
    requestHandler: { handle } as unknown as FlagshipRequestHandler,
    loadFleets: vi.fn().mockResolvedValue([{
      id: "fleet-1",
      repos: [{ localPath: "/home/user/repo", remote: "owner/repo" }] as FleetRepo[],
      maxConcurrentSorties: 6,
    }]),
    loadRules: vi.fn().mockResolvedValue(""),
    broadcastRequestResult: vi.fn(),
    _handle: handle,
  };
}

// === HTTP test helpers ===

function startServer(deps: ReturnType<typeof createMockDeps>): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const handler = createApiHandler(deps);
    const server = createServer(handler);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

async function apiRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: { ok: boolean; result?: string; error?: string } }> {
  const url = `http://localhost:${port}${path}`;
  const options: RequestInit = {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  };
  const res = await fetch(url, options);
  const data = await res.json() as { ok: boolean; result?: string; error?: string };
  return { status: res.status, data };
}

describe("API Server", () => {
  let deps: ReturnType<typeof createMockDeps>;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    deps = createMockDeps();
    const s = await startServer(deps);
    server = s.server;
    port = s.port;
  });

  afterEach(() => {
    server.close();
  });

  describe("GET /api/ship-status", () => {
    it("returns ship status", async () => {
      deps._handle.mockResolvedValue("[Ship Status] No active ships.");
      const res = await apiRequest(port, "GET", "/api/ship-status");
      expect(res.status).toBe(200);
      expect(res.data.ok).toBe(true);
      expect(res.data.result).toContain("No active ships");
      expect(deps.broadcastRequestResult).toHaveBeenCalledWith("fleet-1", expect.any(String));
    });
  });

  describe("POST /api/sortie", () => {
    it("launches a sortie with valid request", async () => {
      deps._handle.mockResolvedValue("[Sortie Results]\nShip launched for owner/repo#42");
      const res = await apiRequest(port, "POST", "/api/sortie", {
        items: [{ repo: "owner/repo", issueNumber: 42 }],
      });
      expect(res.status).toBe(200);
      expect(res.data.ok).toBe(true);
      expect(res.data.result).toContain("launched");
    });

    it("rejects sortie with empty items", async () => {
      const res = await apiRequest(port, "POST", "/api/sortie", {
        items: [],
      });
      expect(res.status).toBe(400);
      expect(res.data.ok).toBe(false);
      expect(res.data.error).toContain("non-empty");
    });

    it("rejects sortie with invalid repo format", async () => {
      const res = await apiRequest(port, "POST", "/api/sortie", {
        items: [{ repo: "invalid-repo", issueNumber: 42 }],
      });
      expect(res.status).toBe(400);
      expect(res.data.ok).toBe(false);
      expect(res.data.error).toContain("Invalid repo format");
    });

    it("rejects sortie with invalid issueNumber", async () => {
      const res = await apiRequest(port, "POST", "/api/sortie", {
        items: [{ repo: "owner/repo", issueNumber: -1 }],
      });
      expect(res.status).toBe(400);
      expect(res.data.ok).toBe(false);
      expect(res.data.error).toContain("issueNumber");
    });
  });

  describe("POST /api/ship-stop", () => {
    it("stops a ship with valid shipId", async () => {
      deps._handle.mockResolvedValue("[Ship Stopped] ship-123");
      const res = await apiRequest(port, "POST", "/api/ship-stop", {
        shipId: "ship-123",
      });
      expect(res.status).toBe(200);
      expect(res.data.ok).toBe(true);
    });

    it("rejects without shipId", async () => {
      const res = await apiRequest(port, "POST", "/api/ship-stop", {});
      expect(res.status).toBe(400);
      expect(res.data.ok).toBe(false);
      expect(res.data.error).toContain("shipId");
    });
  });

  describe("POST /api/ship-resume", () => {
    it("resumes a ship with valid shipId", async () => {
      deps._handle.mockResolvedValue("[Ship Resumed] Ship #42");
      const res = await apiRequest(port, "POST", "/api/ship-resume", {
        shipId: "ship-123",
      });
      expect(res.status).toBe(200);
      expect(res.data.ok).toBe(true);
    });

    it("rejects without shipId", async () => {
      const res = await apiRequest(port, "POST", "/api/ship-resume", {});
      expect(res.status).toBe(400);
      expect(res.data.ok).toBe(false);
    });
  });

  describe("POST /api/pr-review-result", () => {
    it("submits approve verdict", async () => {
      deps._handle.mockResolvedValue("[PR Review Result] APPROVED");
      const res = await apiRequest(port, "POST", "/api/pr-review-result", {
        shipId: "ship-123",
        prNumber: 42,
        verdict: "approve",
      });
      expect(res.status).toBe(200);
      expect(res.data.ok).toBe(true);
    });

    it("submits request-changes verdict with comments", async () => {
      deps._handle.mockResolvedValue("[PR Review Result] CHANGES REQUESTED");
      const res = await apiRequest(port, "POST", "/api/pr-review-result", {
        shipId: "ship-123",
        prNumber: 42,
        verdict: "request-changes",
        comments: "Fix the tests",
      });
      expect(res.status).toBe(200);
      expect(res.data.ok).toBe(true);
    });

    it("rejects with invalid verdict", async () => {
      const res = await apiRequest(port, "POST", "/api/pr-review-result", {
        shipId: "ship-123",
        prNumber: 42,
        verdict: "invalid",
      });
      expect(res.status).toBe(400);
      expect(res.data.ok).toBe(false);
      expect(res.data.error).toContain("verdict");
    });

    it("rejects with missing prNumber", async () => {
      const res = await apiRequest(port, "POST", "/api/pr-review-result", {
        shipId: "ship-123",
        verdict: "approve",
      });
      expect(res.status).toBe(400);
      expect(res.data.ok).toBe(false);
      expect(res.data.error).toContain("prNumber");
    });
  });

  describe("error handling", () => {
    it("returns 404 for unknown routes", async () => {
      const res = await apiRequest(port, "GET", "/api/unknown");
      expect(res.status).toBe(404);
      expect(res.data.ok).toBe(false);
    });

    it("returns 404 for non-api routes", async () => {
      const res = await apiRequest(port, "GET", "/not-api");
      expect(res.status).toBe(404);
    });

    it("returns 405 for wrong method on POST endpoints", async () => {
      const res = await apiRequest(port, "GET", "/api/sortie");
      expect(res.status).toBe(405);
      expect(res.data.ok).toBe(false);
    });

    it("returns 400 for invalid JSON body", async () => {
      const url = `http://localhost:${port}/api/sortie`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json",
      });
      const data = await res.json() as { ok: boolean; error?: string };
      expect(res.status).toBe(400);
      expect(data.ok).toBe(false);
      expect(data.error).toContain("Invalid JSON");
    });

    it("returns 500 on handler error", async () => {
      deps._handle.mockRejectedValue(new Error("Internal failure"));
      const res = await apiRequest(port, "POST", "/api/ship-stop", {
        shipId: "ship-123",
      });
      expect(res.status).toBe(500);
      expect(res.data.ok).toBe(false);
      expect(res.data.error).toContain("Internal failure");
    });
  });

  describe("fleetId resolution", () => {
    it("auto-resolves when single fleet exists", async () => {
      deps._handle.mockResolvedValue("[Ship Status] ok");
      const res = await apiRequest(port, "GET", "/api/ship-status");
      expect(res.status).toBe(200);
      expect(deps._handle).toHaveBeenCalledWith(
        "fleet-1",
        expect.objectContaining({ request: "ship-status" }),
        expect.any(Array),
        expect.any(Array),
      );
    });

    it("uses explicit fleetId from body", async () => {
      deps._handle.mockResolvedValue("[Ship Stopped]");
      const res = await apiRequest(port, "POST", "/api/ship-stop", {
        fleetId: "fleet-1",
        shipId: "ship-123",
      });
      expect(res.status).toBe(200);
    });

    it("returns error when multiple fleets and no fleetId", async () => {
      deps.loadFleets.mockResolvedValue([
        { id: "fleet-1", repos: [], maxConcurrentSorties: 6 },
        { id: "fleet-2", repos: [], maxConcurrentSorties: 6 },
      ]);
      const res = await apiRequest(port, "GET", "/api/ship-status");
      expect(res.status).toBe(400);
      expect(res.data.error).toContain("fleetId is required");
    });

    it("returns error when no fleets configured", async () => {
      deps.loadFleets.mockResolvedValue([]);
      const res = await apiRequest(port, "GET", "/api/ship-status");
      expect(res.status).toBe(400);
      expect(res.data.error).toContain("No fleets");
    });
  });
});
