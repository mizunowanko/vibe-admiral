import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createApiHandler } from "../api-server.js";
import type { FleetRepo } from "../types.js";
import type { FlagshipRequestHandler } from "../bridge-request-handler.js";
import type { FleetDatabase } from "../db.js";
import type { ShipManager } from "../ship-manager.js";

// === Mock deps ===

function createMockDeps() {
  const handle = vi.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue("");

  return {
    requestHandler: { handle } as unknown as FlagshipRequestHandler,
    getDatabase: vi.fn().mockReturnValue(null),
    getShipManager: vi.fn().mockReturnValue({ syncPhaseFromDb: vi.fn() }),
    getDispatchManager: vi.fn().mockReturnValue({ launch: vi.fn(), toDispatch: vi.fn(), getDispatchesByFleet: vi.fn().mockReturnValue([]) }),
    getEscortManager: vi.fn().mockReturnValue({ launchEscort: vi.fn().mockReturnValue("escort-1"), isEscortRunning: vi.fn().mockReturnValue(false), setGateIntent: vi.fn(), clearGateIntent: vi.fn() }),
    getActorManager: vi.fn().mockReturnValue({ send: vi.fn() }),
    getCommanderHistory: vi.fn().mockResolvedValue([]),
    loadFleets: vi.fn().mockResolvedValue([{
      id: "fleet-1",
      repos: [{ localPath: "/home/user/repo", remote: "owner/repo" }] as FleetRepo[],
      maxConcurrentSorties: 6,
    }]),
    loadRules: vi.fn().mockResolvedValue(""),
    loadAdmiralSettings: vi.fn().mockResolvedValue({ global: {}, template: {} }),
    broadcastRequestResult: vi.fn(),
    notifyGateSkip: vi.fn(),
    deliverHeadsUp: vi.fn().mockReturnValue(true),
    resumeAllUnits: vi.fn().mockResolvedValue([]),
    requestRestart: vi.fn(),
    _handle: handle,
  };
}

/** Create mock deps with a mock FleetDatabase for Ship/Escort API tests */
function createMockDepsWithDb() {
  const deps = createMockDeps();
  const syncPhaseFromDb = vi.fn();

  const mockDb = {
    getShipById: vi.fn(),
    persistPhaseTransition: vi.fn().mockReturnValue(true),
    getPhaseTransitions: vi.fn().mockReturnValue([]),
  };

  deps.getDatabase.mockReturnValue(mockDb as unknown as FleetDatabase);
  const setGateCheck = vi.fn();
  const clearGateCheck = vi.fn();
  deps.getShipManager.mockReturnValue({ syncPhaseFromDb, setGateCheck, clearGateCheck } as unknown as ShipManager);

  // Default: actorManager.requestTransition succeeds (XState approves)
  const requestTransition = vi.fn().mockReturnValue({ success: true, fromPhase: "plan", toPhase: "plan-gate" });
  const assertPhaseConsistency = vi.fn().mockReturnValue(true);
  const reconcilePhase = vi.fn().mockReturnValue(false);
  const getPersistedSnapshot = vi.fn().mockReturnValue({ value: "plan", context: {} });
  deps.getActorManager.mockReturnValue({ send: vi.fn(), requestTransition, assertPhaseConsistency, reconcilePhase, getPersistedSnapshot });

  return {
    ...deps,
    _mockDb: mockDb,
    _syncPhaseFromDb: syncPhaseFromDb,
    _setGateCheck: setGateCheck,
    _clearGateCheck: clearGateCheck,
    _requestTransition: requestTransition,
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

interface ApiResponseData {
  ok: boolean;
  result?: string;
  error?: string;
  phase?: string;
  transitions?: Array<Record<string, unknown>>;
}

async function apiRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: ApiResponseData }> {
  const url = `http://localhost:${port}${path}`;
  const options: RequestInit = {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  };
  const res = await fetch(url, options);
  const data = await res.json() as ApiResponseData;
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

  describe("POST /api/ship-pause", () => {
    it("pauses a ship with valid shipId", async () => {
      deps._handle.mockResolvedValue("[Ship Paused] ship-123");
      const res = await apiRequest(port, "POST", "/api/ship-pause", {
        shipId: "ship-123",
      });
      expect(res.status).toBe(200);
      expect(res.data.ok).toBe(true);
    });

    it("rejects without shipId", async () => {
      const res = await apiRequest(port, "POST", "/api/ship-pause", {});
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
      const res = await apiRequest(port, "POST", "/api/ship-pause", {
        shipId: "ship-123",
      });
      expect(res.status).toBe(500);
      expect(res.data.ok).toBe(false);
      expect(res.data.error).toContain("Internal failure");
    });
  });

  describe("Ship/Escort API", () => {
    describe("GET /api/ship/:id/phase", () => {
      it("returns current phase", async () => {
        const depsWithDb = createMockDepsWithDb();
        depsWithDb._mockDb.getShipById.mockReturnValue({ id: "ship-1", phase: "coding" });
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "GET", "/api/ship/ship-1/phase");
          expect(res.status).toBe(200);
          expect(res.data.ok).toBe(true);
          expect(res.data.phase).toBe("coding");
        } finally {
          s2.server.close();
        }
      });

      it("returns 404 for unknown ship", async () => {
        const depsWithDb = createMockDepsWithDb();
        depsWithDb._mockDb.getShipById.mockReturnValue(undefined);
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "GET", "/api/ship/unknown/phase");
          expect(res.status).toBe(404);
          expect(res.data.ok).toBe(false);
        } finally {
          s2.server.close();
        }
      });

      it("returns 503 when database not initialized", async () => {
        // Default deps have getDatabase returning null
        const res = await apiRequest(port, "GET", "/api/ship/ship-1/phase");
        expect(res.status).toBe(503);
        expect(res.data.ok).toBe(false);
        expect(res.data.error).toContain("Database not initialized");
      });
    });

    describe("POST /api/ship/:id/phase-transition", () => {
      it("transitions phase successfully via XState", async () => {
        const depsWithDb = createMockDepsWithDb();
        depsWithDb._mockDb.getShipById.mockReturnValue({ id: "ship-1", phase: "plan" });
        depsWithDb._requestTransition.mockReturnValue({ success: true, fromPhase: "plan", toPhase: "plan-gate" });
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "POST", "/api/ship/ship-1/phase-transition", {
            phase: "plan-gate",
            metadata: { planCommentUrl: "https://example.com" },
          });
          expect(res.status).toBe(200);
          expect(res.data.ok).toBe(true);
          expect(res.data.phase).toBe("plan-gate");
          // XState requestTransition should be called first
          expect(depsWithDb._requestTransition).toHaveBeenCalledWith(
            "ship-1", { type: "GATE_ENTER" },
          );
          // Then DB persist
          expect(depsWithDb._mockDb.persistPhaseTransition).toHaveBeenCalledWith(
            "ship-1", "plan", "plan-gate", "ship",
            { planCommentUrl: "https://example.com" },
            expect.anything(),
          );
          expect(depsWithDb._syncPhaseFromDb).toHaveBeenCalledWith("ship-1");
        } finally {
          s2.server.close();
        }
      });

      it("rejects without phase", async () => {
        const depsWithDb = createMockDepsWithDb();
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "POST", "/api/ship/ship-1/phase-transition", {});
          expect(res.status).toBe(400);
          expect(res.data.error).toContain("phase is required");
        } finally {
          s2.server.close();
        }
      });

      it("rejects invalid phase", async () => {
        const depsWithDb = createMockDepsWithDb();
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "POST", "/api/ship/ship-1/phase-transition", {
            phase: "bogus-phase",
          });
          expect(res.status).toBe(400);
          expect(res.data.error).toContain("Invalid phase");
        } finally {
          s2.server.close();
        }
      });

      it("returns 404 for unknown ship", async () => {
        const depsWithDb = createMockDepsWithDb();
        depsWithDb._mockDb.getShipById.mockReturnValue(undefined);
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "POST", "/api/ship/unknown/phase-transition", {
            phase: "plan-gate",
          });
          expect(res.status).toBe(404);
        } finally {
          s2.server.close();
        }
      });

      it("returns 409 when XState rejects transition", async () => {
        const depsWithDb = createMockDepsWithDb();
        depsWithDb._mockDb.getShipById.mockReturnValue({ id: "ship-1", phase: "plan" });
        depsWithDb._requestTransition.mockReturnValue({ success: false, currentPhase: "plan" });
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "POST", "/api/ship/ship-1/phase-transition", {
            phase: "done",
          });
          expect(res.status).toBe(409);
          expect(res.data.error).toContain("Transition rejected by XState");
        } finally {
          s2.server.close();
        }
      });
    });

    describe("POST /api/ship/:id/gate-verdict", () => {
      it("approves gate via XState and persists to DB", async () => {
        const depsWithDb = createMockDepsWithDb();
        depsWithDb._mockDb.getShipById.mockReturnValue({ id: "ship-1", phase: "plan-gate" });
        depsWithDb._requestTransition.mockReturnValue({ success: true, fromPhase: "plan-gate", toPhase: "coding" });
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "POST", "/api/ship/ship-1/gate-verdict", {
            verdict: "approve",
          });
          expect(res.status).toBe(200);
          expect(res.data.ok).toBe(true);
          expect(res.data.phase).toBe("coding");
          expect(depsWithDb._requestTransition).toHaveBeenCalledWith(
            "ship-1", { type: "GATE_APPROVED" },
          );
          expect(depsWithDb._mockDb.persistPhaseTransition).toHaveBeenCalledWith(
            "ship-1", "plan-gate", "coding", "escort",
            { gate_result: "approved" },
            expect.anything(),
          );
          expect(depsWithDb._syncPhaseFromDb).toHaveBeenCalledWith("ship-1");
        } finally {
          s2.server.close();
        }
      });

      it("rejects gate via XState and persists to DB", async () => {
        const depsWithDb = createMockDepsWithDb();
        depsWithDb._mockDb.getShipById.mockReturnValue({ id: "ship-1", phase: "coding-gate" });
        depsWithDb._requestTransition.mockReturnValue({ success: true, fromPhase: "coding-gate", toPhase: "coding" });
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "POST", "/api/ship/ship-1/gate-verdict", {
            verdict: "reject",
            feedback: "Tests are missing",
          });
          expect(res.status).toBe(200);
          expect(res.data.phase).toBe("coding");
          expect(depsWithDb._requestTransition).toHaveBeenCalledWith(
            "ship-1", { type: "GATE_REJECTED", feedback: { summary: "Tests are missing", items: [] } },
          );
          expect(depsWithDb._mockDb.persistPhaseTransition).toHaveBeenCalledWith(
            "ship-1", "coding-gate", "coding", "escort",
            { gate_result: "rejected", feedback: { summary: "Tests are missing", items: [] } },
            expect.anything(),
          );
        } finally {
          s2.server.close();
        }
      });

      it("rejects when ship not in gate phase", async () => {
        const depsWithDb = createMockDepsWithDb();
        depsWithDb._mockDb.getShipById.mockReturnValue({ id: "ship-1", phase: "coding" });
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "POST", "/api/ship/ship-1/gate-verdict", {
            verdict: "approve",
          });
          expect(res.status).toBe(400);
          expect(res.data.error).toContain("not in a gate phase");
        } finally {
          s2.server.close();
        }
      });

      it("rejects invalid verdict", async () => {
        const depsWithDb = createMockDepsWithDb();
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "POST", "/api/ship/ship-1/gate-verdict", {
            verdict: "maybe",
          });
          expect(res.status).toBe(400);
          expect(res.data.error).toContain("verdict");
        } finally {
          s2.server.close();
        }
      });
    });

    describe("POST /api/ship/:id/nothing-to-do", () => {
      it("transitions ship to done via XState", async () => {
        const depsWithDb = createMockDepsWithDb();
        depsWithDb._mockDb.getShipById.mockReturnValue({ id: "ship-1", phase: "plan" });
        depsWithDb._requestTransition.mockReturnValue({ success: true, fromPhase: "plan", toPhase: "done" });
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "POST", "/api/ship/ship-1/nothing-to-do", {
            reason: "Issue already resolved",
          });
          expect(res.status).toBe(200);
          expect(res.data.phase).toBe("done");
          expect(depsWithDb._requestTransition).toHaveBeenCalledWith(
            "ship-1", { type: "NOTHING_TO_DO", reason: "Issue already resolved" },
          );
          expect(depsWithDb._mockDb.persistPhaseTransition).toHaveBeenCalledWith(
            "ship-1", "plan", "done", "ship",
            { reason: "Issue already resolved", nothingToDo: true },
            expect.anything(),
          );
        } finally {
          s2.server.close();
        }
      });

      it("returns 404 for unknown ship", async () => {
        const depsWithDb = createMockDepsWithDb();
        depsWithDb._mockDb.getShipById.mockReturnValue(undefined);
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "POST", "/api/ship/unknown/nothing-to-do", {
            reason: "test",
          });
          expect(res.status).toBe(404);
        } finally {
          s2.server.close();
        }
      });
    });

    describe("GET /api/ship/:id/phase-transition-log", () => {
      it("returns transition log", async () => {
        const depsWithDb = createMockDepsWithDb();
        depsWithDb._mockDb.getShipById.mockReturnValue({ id: "ship-1", phase: "coding" });
        depsWithDb._mockDb.getPhaseTransitions.mockReturnValue([
          { id: 1, shipId: "ship-1", fromPhase: "plan-gate", toPhase: "coding", triggeredBy: "escort", metadata: { gate_result: "approved" }, createdAt: "2025-01-01" },
        ]);
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "GET", "/api/ship/ship-1/phase-transition-log?limit=1");
          expect(res.status).toBe(200);
          expect(res.data.ok).toBe(true);
          const data = res.data;
          expect(data.transitions).toHaveLength(1);
          expect(data.transitions![0]!.fromPhase).toBe("plan-gate");
          expect(depsWithDb._mockDb.getPhaseTransitions).toHaveBeenCalledWith("ship-1", 1);
        } finally {
          s2.server.close();
        }
      });
    });

    describe("POST /api/ship/:id/abandon", () => {
      it("abandons a paused ship", async () => {
        const depsWithDb = createMockDepsWithDb();
        depsWithDb._mockDb.getShipById.mockReturnValue({ id: "ship-1", phase: "paused" });
        const abandonShip = vi.fn().mockReturnValue(true);
        depsWithDb.getShipManager.mockReturnValue({
          ...depsWithDb.getShipManager(),
          abandonShip,
        } as unknown as ShipManager);
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "POST", "/api/ship/ship-1/abandon", {});
          expect(res.status).toBe(200);
          expect(res.data.ok).toBe(true);
          expect(res.data.phase).toBe("abandoned");
        } finally {
          s2.server.close();
        }
      });

      it("rejects abandon for non-paused ship", async () => {
        const depsWithDb = createMockDepsWithDb();
        depsWithDb._mockDb.getShipById.mockReturnValue({ id: "ship-1", phase: "coding" });
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "POST", "/api/ship/ship-1/abandon", {});
          expect(res.status).toBe(400);
          expect(res.data.error).toContain("paused");
        } finally {
          s2.server.close();
        }
      });

      it("returns 404 for unknown ship", async () => {
        const depsWithDb = createMockDepsWithDb();
        depsWithDb._mockDb.getShipById.mockReturnValue(undefined);
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "POST", "/api/ship/unknown/abandon", {});
          expect(res.status).toBe(404);
        } finally {
          s2.server.close();
        }
      });
    });

    describe("DELETE /api/ship/:id/delete", () => {
      it("deletes a ship", async () => {
        const depsWithDb = createMockDepsWithDb();
        const deleteShip = vi.fn().mockReturnValue(true);
        depsWithDb.getShipManager.mockReturnValue({
          ...depsWithDb.getShipManager(),
          deleteShip,
        } as unknown as ShipManager);
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "DELETE", "/api/ship/ship-1/delete");
          expect(res.status).toBe(200);
          expect(res.data.ok).toBe(true);
        } finally {
          s2.server.close();
        }
      });

      it("returns 404 when ship not found", async () => {
        const depsWithDb = createMockDepsWithDb();
        const deleteShip = vi.fn().mockReturnValue(false);
        depsWithDb.getShipManager.mockReturnValue({
          ...depsWithDb.getShipManager(),
          deleteShip,
        } as unknown as ShipManager);
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "DELETE", "/api/ship/unknown/delete");
          expect(res.status).toBe(404);
        } finally {
          s2.server.close();
        }
      });
    });

    describe("POST /api/ship-abandon", () => {
      it("abandons via flagship route", async () => {
        deps._handle.mockResolvedValue("[Ship Abandoned] Ship #42");
        const res = await apiRequest(port, "POST", "/api/ship-abandon", {
          shipId: "ship-123",
        });
        expect(res.status).toBe(200);
        expect(res.data.ok).toBe(true);
      });

      it("rejects without shipId", async () => {
        const res = await apiRequest(port, "POST", "/api/ship-abandon", {});
        expect(res.status).toBe(400);
        expect(res.data.error).toContain("shipId");
      });
    });

    describe("POST /api/ship-delete", () => {
      it("deletes via flagship route", async () => {
        deps._handle.mockResolvedValue("[Ship Deleted] Ship #42");
        const res = await apiRequest(port, "POST", "/api/ship-delete", {
          shipId: "ship-123",
        });
        expect(res.status).toBe(200);
        expect(res.data.ok).toBe(true);
      });

      it("rejects without shipId", async () => {
        const res = await apiRequest(port, "POST", "/api/ship-delete", {});
        expect(res.status).toBe(400);
        expect(res.data.error).toContain("shipId");
      });
    });

    describe("unknown ship action", () => {
      it("returns 404 for unknown action", async () => {
        const depsWithDb = createMockDepsWithDb();
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "POST", "/api/ship/ship-1/unknown-action", {});
          expect(res.status).toBe(404);
          expect(res.data.error).toContain("Unknown ship action");
        } finally {
          s2.server.close();
        }
      });
    });
  });

  describe("GET /api/commander-logs", () => {
    it("returns flagship logs with default limit", async () => {
      const mockLogs = [
        { type: "user", content: "hello" },
        { type: "assistant", content: "hi there" },
      ];
      deps.getCommanderHistory.mockResolvedValue(mockLogs);
      const res = await apiRequest(port, "GET", "/api/commander-logs?role=flagship");
      expect(res.status).toBe(200);
      const data = res.data as ApiResponseData & { logs: unknown[]; role: string; fleetId: string };
      expect(data.ok).toBe(true);
      expect(data.logs).toHaveLength(2);
      expect(data.role).toBe("flagship");
      expect(data.fleetId).toBe("fleet-1");
      expect(deps.getCommanderHistory).toHaveBeenCalledWith("flagship", "fleet-1");
    });

    it("returns dock logs", async () => {
      deps.getCommanderHistory.mockResolvedValue([{ type: "user", content: "test" }]);
      const res = await apiRequest(port, "GET", "/api/commander-logs?role=dock");
      expect(res.status).toBe(200);
      const data = res.data as ApiResponseData & { logs: unknown[]; role: string };
      expect(data.ok).toBe(true);
      expect(data.logs).toHaveLength(1);
      expect(data.role).toBe("dock");
      expect(deps.getCommanderHistory).toHaveBeenCalledWith("dock", "fleet-1");
    });

    it("respects limit parameter", async () => {
      const mockLogs = Array.from({ length: 200 }, (_, i) => ({ type: "user", content: `msg-${i}` }));
      deps.getCommanderHistory.mockResolvedValue(mockLogs);
      const res = await apiRequest(port, "GET", "/api/commander-logs?role=flagship&limit=50");
      expect(res.status).toBe(200);
      const data = res.data as ApiResponseData & { logs: unknown[] };
      expect(data.logs).toHaveLength(50);
    });

    it("caps limit at 500", async () => {
      const mockLogs = Array.from({ length: 500 }, (_, i) => ({ type: "user", content: `msg-${i}` }));
      deps.getCommanderHistory.mockResolvedValue(mockLogs);
      const res = await apiRequest(port, "GET", "/api/commander-logs?role=flagship&limit=9999");
      expect(res.status).toBe(200);
      const data = res.data as ApiResponseData & { logs: unknown[] };
      expect(data.logs).toHaveLength(500);
    });

    it("returns 400 when role is missing", async () => {
      const res = await apiRequest(port, "GET", "/api/commander-logs");
      expect(res.status).toBe(400);
      expect(res.data.error).toContain("role");
    });

    it("returns 400 for invalid role", async () => {
      const res = await apiRequest(port, "GET", "/api/commander-logs?role=invalid");
      expect(res.status).toBe(400);
      expect(res.data.error).toContain("role");
    });

    it("returns empty array when commander not started", async () => {
      deps.getCommanderHistory.mockResolvedValue([]);
      const res = await apiRequest(port, "GET", "/api/commander-logs?role=flagship");
      expect(res.status).toBe(200);
      const data = res.data as ApiResponseData & { logs: unknown[] };
      expect(data.ok).toBe(true);
      expect(data.logs).toHaveLength(0);
    });

    it("resolves fleetId from query parameter", async () => {
      deps.getCommanderHistory.mockResolvedValue([]);
      const res = await apiRequest(port, "GET", "/api/commander-logs?role=flagship&fleetId=fleet-1");
      expect(res.status).toBe(200);
      expect(deps.getCommanderHistory).toHaveBeenCalledWith("flagship", "fleet-1");
    });

    it("returns 400 for unknown fleetId", async () => {
      const res = await apiRequest(port, "GET", "/api/commander-logs?role=flagship&fleetId=unknown");
      expect(res.status).toBe(400);
      expect(res.data.error).toContain("Fleet not found");
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
      deps._handle.mockResolvedValue("[Ship Paused]");
      const res = await apiRequest(port, "POST", "/api/ship-pause", {
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
