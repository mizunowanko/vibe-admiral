import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createApiHandler } from "../api-server.js";
import type { FleetRepo } from "../types.js";
import type { FlagshipRequestHandler } from "../bridge-request-handler.js";

// === Mock loadFleets/saveFleets in fleet-config-api ===
vi.mock("../api-handlers.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    loadFleets: vi.fn().mockResolvedValue([{
      id: "fleet-1",
      name: "test-fleet",
      repos: [{ localPath: "/home/user/repo", remote: "owner/repo" }],
      customInstructions: { shared: "original shared" },
      gates: { "plan-gate": true },
      gatePrompts: { "code-review": "original prompt" },
      maxConcurrentSorties: 6,
      acceptanceTestRequired: true,
      qaRequiredPaths: ["src/**"],
      createdAt: "2026-01-01T00:00:00.000Z",
    }]),
    saveFleets: vi.fn().mockResolvedValue(undefined),
  };
});

function createMockDeps() {
  const handle = vi.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue("");

  return {
    requestHandler: { handle } as unknown as FlagshipRequestHandler,
    getDatabase: vi.fn().mockReturnValue(null),
    getShipManager: vi.fn().mockReturnValue({ syncPhaseFromDb: vi.fn() }),
    getDispatchManager: vi.fn().mockReturnValue({ launch: vi.fn(), toDispatch: vi.fn(), getDispatchesByFleet: vi.fn().mockReturnValue([]) }),
    getEscortManager: vi.fn().mockReturnValue({ launchEscort: vi.fn(), isEscortRunning: vi.fn().mockReturnValue(false), setGateIntent: vi.fn(), clearGateIntent: vi.fn() }),
    getActorManager: vi.fn().mockReturnValue({ send: vi.fn() }),
    getCommanderHistory: vi.fn().mockResolvedValue([]),
    loadFleets: vi.fn().mockResolvedValue([{
      id: "fleet-1",
      name: "test-fleet",
      repos: [{ localPath: "/home/user/repo", remote: "owner/repo" }] as FleetRepo[],
      customInstructions: { shared: "original shared" },
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
  fleet?: Record<string, unknown>;
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

describe("Fleet Config API", () => {
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

  describe("GET /api/fleet-config", () => {
    it("returns fleet configuration", async () => {
      const res = await apiRequest(port, "GET", "/api/fleet-config?fleetId=fleet-1");
      expect(res.status).toBe(200);
      expect(res.data.ok).toBe(true);
      expect(res.data.fleet).toBeDefined();
      expect(res.data.fleet!.id).toBe("fleet-1");
      expect(res.data.fleet!.name).toBe("test-fleet");
      expect(res.data.fleet!.customInstructions).toEqual({ shared: "original shared" });
    });

    it("returns 404 for unknown fleet", async () => {
      const res = await apiRequest(port, "GET", "/api/fleet-config?fleetId=unknown");
      expect(res.status).toBe(404);
      expect(res.data.ok).toBe(false);
      expect(res.data.error).toContain("Fleet not found");
    });

    it("auto-resolves fleetId when single fleet exists", async () => {
      const res = await apiRequest(port, "GET", "/api/fleet-config");
      expect(res.status).toBe(200);
      expect(res.data.ok).toBe(true);
      expect(res.data.fleet!.id).toBe("fleet-1");
    });
  });

  describe("PATCH /api/fleet-config", () => {
    it("updates customInstructions", async () => {
      const { saveFleets } = await import("../api-handlers.js");
      const res = await apiRequest(port, "PATCH", "/api/fleet-config", {
        fleetId: "fleet-1",
        customInstructions: { shared: "updated shared", ship: "new ship instructions" },
      });
      expect(res.status).toBe(200);
      expect(res.data.ok).toBe(true);
      expect(res.data.result).toContain("customInstructions");
      expect(saveFleets).toHaveBeenCalled();
    });

    it("updates maxConcurrentSorties", async () => {
      const res = await apiRequest(port, "PATCH", "/api/fleet-config", {
        fleetId: "fleet-1",
        maxConcurrentSorties: 4,
      });
      expect(res.status).toBe(200);
      expect(res.data.ok).toBe(true);
      expect(res.data.result).toContain("maxConcurrentSorties");
    });

    it("notifies both commanders after update", async () => {
      await apiRequest(port, "PATCH", "/api/fleet-config", {
        fleetId: "fleet-1",
        maxConcurrentSorties: 4,
      });
      expect(deps.deliverHeadsUp).toHaveBeenCalledTimes(2);
      expect(deps.deliverHeadsUp).toHaveBeenCalledWith(
        expect.objectContaining({ from: "flagship", to: "dock", fleetId: "fleet-1" }),
      );
      expect(deps.deliverHeadsUp).toHaveBeenCalledWith(
        expect.objectContaining({ from: "dock", to: "flagship", fleetId: "fleet-1" }),
      );
    });

    it("rejects unknown fields", async () => {
      const res = await apiRequest(port, "PATCH", "/api/fleet-config", {
        fleetId: "fleet-1",
        name: "new-name",
      });
      expect(res.status).toBe(400);
      expect(res.data.ok).toBe(false);
      expect(res.data.error).toContain("non-updatable");
    });

    it("rejects empty update", async () => {
      const res = await apiRequest(port, "PATCH", "/api/fleet-config", {
        fleetId: "fleet-1",
      });
      expect(res.status).toBe(400);
      expect(res.data.ok).toBe(false);
      expect(res.data.error).toContain("No fields to update");
    });

    it("returns 404 for unknown fleet", async () => {
      const res = await apiRequest(port, "PATCH", "/api/fleet-config", {
        fleetId: "unknown",
        maxConcurrentSorties: 4,
      });
      expect(res.status).toBe(404);
      expect(res.data.ok).toBe(false);
    });

    it("validates maxConcurrentSorties is a positive integer", async () => {
      const res = await apiRequest(port, "PATCH", "/api/fleet-config", {
        fleetId: "fleet-1",
        maxConcurrentSorties: -1,
      });
      expect(res.status).toBe(400);
      expect(res.data.error).toContain("positive integer");
    });

    it("validates acceptanceTestRequired is a boolean", async () => {
      const res = await apiRequest(port, "PATCH", "/api/fleet-config", {
        fleetId: "fleet-1",
        acceptanceTestRequired: "yes",
      });
      expect(res.status).toBe(400);
      expect(res.data.error).toContain("boolean");
    });

    it("validates customInstructions is an object", async () => {
      const res = await apiRequest(port, "PATCH", "/api/fleet-config", {
        fleetId: "fleet-1",
        customInstructions: "not an object",
      });
      expect(res.status).toBe(400);
      expect(res.data.error).toContain("customInstructions must be an object");
    });

    it("validates gatePrompts is an object", async () => {
      const res = await apiRequest(port, "PATCH", "/api/fleet-config", {
        fleetId: "fleet-1",
        gatePrompts: ["not", "an", "object"],
      });
      expect(res.status).toBe(400);
      expect(res.data.error).toContain("gatePrompts must be an object");
    });

    it("validates gates is an object", async () => {
      const res = await apiRequest(port, "PATCH", "/api/fleet-config", {
        fleetId: "fleet-1",
        gates: 42,
      });
      expect(res.status).toBe(400);
      expect(res.data.error).toContain("gates must be an object");
    });

    it("validates qaRequiredPaths is an array of strings", async () => {
      const res = await apiRequest(port, "PATCH", "/api/fleet-config", {
        fleetId: "fleet-1",
        qaRequiredPaths: [1, 2, 3],
      });
      expect(res.status).toBe(400);
      expect(res.data.error).toContain("array of strings");
    });
  });
});
