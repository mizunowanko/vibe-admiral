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
    getEscortManager: vi.fn().mockReturnValue({ launchEscort: vi.fn().mockReturnValue("escort-1"), isEscortRunning: vi.fn().mockReturnValue(false) }),
    getActorManager: vi.fn().mockReturnValue({ send: vi.fn() }),
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

/** Create mock deps with a mock FleetDatabase for Ship/Escort API tests */
function createMockDepsWithDb() {
  const deps = createMockDeps();
  const syncPhaseFromDb = vi.fn();

  const mockDb = {
    getShipById: vi.fn(),
    transitionPhase: vi.fn().mockReturnValue(true),
    getPhaseTransitions: vi.fn().mockReturnValue([]),
  };

  deps.getDatabase.mockReturnValue(mockDb as unknown as FleetDatabase);
  const setGateCheck = vi.fn();
  const clearGateCheck = vi.fn();
  deps.getShipManager.mockReturnValue({ syncPhaseFromDb, setGateCheck, clearGateCheck } as unknown as ShipManager);

  return { ...deps, _mockDb: mockDb, _syncPhaseFromDb: syncPhaseFromDb, _setGateCheck: setGateCheck, _clearGateCheck: clearGateCheck };
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

  describe("Ship/Escort API", () => {
    describe("GET /api/ship/:id/phase", () => {
      it("returns current phase", async () => {
        const depsWithDb = createMockDepsWithDb();
        depsWithDb._mockDb.getShipById.mockReturnValue({ id: "ship-1", phase: "implementing" });
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "GET", "/api/ship/ship-1/phase");
          expect(res.status).toBe(200);
          expect(res.data.ok).toBe(true);
          expect(res.data.phase).toBe("implementing");
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
      it("transitions phase successfully", async () => {
        const depsWithDb = createMockDepsWithDb();
        depsWithDb._mockDb.getShipById.mockReturnValue({ id: "ship-1", phase: "planning" });
        depsWithDb._mockDb.transitionPhase.mockReturnValue(true);
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "POST", "/api/ship/ship-1/phase-transition", {
            phase: "planning-gate",
            metadata: { planCommentUrl: "https://example.com" },
          });
          expect(res.status).toBe(200);
          expect(res.data.ok).toBe(true);
          expect(res.data.phase).toBe("planning-gate");
          expect(depsWithDb._mockDb.transitionPhase).toHaveBeenCalledWith(
            "ship-1", "planning", "planning-gate", "ship",
            { planCommentUrl: "https://example.com" },
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
            phase: "implementing",
          });
          expect(res.status).toBe(404);
        } finally {
          s2.server.close();
        }
      });

      it("returns error on transition failure", async () => {
        const depsWithDb = createMockDepsWithDb();
        depsWithDb._mockDb.getShipById.mockReturnValue({ id: "ship-1", phase: "planning" });
        depsWithDb._mockDb.transitionPhase.mockImplementation(() => {
          throw new Error("Cannot go backward: planning → done");
        });
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "POST", "/api/ship/ship-1/phase-transition", {
            phase: "done",
          });
          expect(res.status).toBe(400);
          expect(res.data.error).toContain("Cannot go backward");
        } finally {
          s2.server.close();
        }
      });
    });

    describe("POST /api/ship/:id/gate-verdict", () => {
      it("approves gate and transitions to next phase", async () => {
        const depsWithDb = createMockDepsWithDb();
        depsWithDb._mockDb.getShipById.mockReturnValue({ id: "ship-1", phase: "planning-gate" });
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "POST", "/api/ship/ship-1/gate-verdict", {
            verdict: "approve",
          });
          expect(res.status).toBe(200);
          expect(res.data.ok).toBe(true);
          expect(res.data.phase).toBe("implementing");
          expect(depsWithDb._mockDb.transitionPhase).toHaveBeenCalledWith(
            "ship-1", "planning-gate", "implementing", "escort",
            { gate_result: "approved" },
          );
          expect(depsWithDb._syncPhaseFromDb).toHaveBeenCalledWith("ship-1");
        } finally {
          s2.server.close();
        }
      });

      it("rejects gate and transitions to previous phase", async () => {
        const depsWithDb = createMockDepsWithDb();
        depsWithDb._mockDb.getShipById.mockReturnValue({ id: "ship-1", phase: "implementing-gate" });
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "POST", "/api/ship/ship-1/gate-verdict", {
            verdict: "reject",
            feedback: "Tests are missing",
          });
          expect(res.status).toBe(200);
          expect(res.data.phase).toBe("implementing");
          expect(depsWithDb._mockDb.transitionPhase).toHaveBeenCalledWith(
            "ship-1", "implementing-gate", "implementing", "escort",
            { gate_result: "rejected", feedback: "Tests are missing" },
          );
        } finally {
          s2.server.close();
        }
      });

      it("rejects when ship not in gate phase", async () => {
        const depsWithDb = createMockDepsWithDb();
        depsWithDb._mockDb.getShipById.mockReturnValue({ id: "ship-1", phase: "implementing" });
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
      it("transitions ship to done", async () => {
        const depsWithDb = createMockDepsWithDb();
        depsWithDb._mockDb.getShipById.mockReturnValue({ id: "ship-1", phase: "planning" });
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "POST", "/api/ship/ship-1/nothing-to-do", {
            reason: "Issue already resolved",
          });
          expect(res.status).toBe(200);
          expect(res.data.phase).toBe("done");
          expect(depsWithDb._mockDb.transitionPhase).toHaveBeenCalledWith(
            "ship-1", "planning", "done", "ship",
            { reason: "Issue already resolved", nothingToDo: true },
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
        depsWithDb._mockDb.getShipById.mockReturnValue({ id: "ship-1", phase: "implementing" });
        depsWithDb._mockDb.getPhaseTransitions.mockReturnValue([
          { id: 1, shipId: "ship-1", fromPhase: "planning-gate", toPhase: "implementing", triggeredBy: "escort", metadata: { gate_result: "approved" }, createdAt: "2025-01-01" },
        ]);
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "GET", "/api/ship/ship-1/phase-transition-log?limit=1");
          expect(res.status).toBe(200);
          expect(res.data.ok).toBe(true);
          const data = res.data;
          expect(data.transitions).toHaveLength(1);
          expect(data.transitions![0]!.fromPhase).toBe("planning-gate");
          expect(depsWithDb._mockDb.getPhaseTransitions).toHaveBeenCalledWith("ship-1", 1);
        } finally {
          s2.server.close();
        }
      });
    });

    describe("POST /api/ship/:id/abandon", () => {
      it("abandons a stopped ship", async () => {
        const depsWithDb = createMockDepsWithDb();
        depsWithDb._mockDb.getShipById.mockReturnValue({ id: "ship-1", phase: "stopped" });
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
          expect(res.data.phase).toBe("done");
        } finally {
          s2.server.close();
        }
      });

      it("rejects abandon for non-stopped ship", async () => {
        const depsWithDb = createMockDepsWithDb();
        depsWithDb._mockDb.getShipById.mockReturnValue({ id: "ship-1", phase: "implementing" });
        const s2 = await startServer(depsWithDb);
        try {
          const res = await apiRequest(s2.port, "POST", "/api/ship/ship-1/abandon", {});
          expect(res.status).toBe(400);
          expect(res.data.error).toContain("stopped");
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
