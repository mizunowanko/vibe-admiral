/**
 * Engine HTTP API helper for E2E test orchestration.
 *
 * Provides typed wrappers around Engine REST API endpoints
 * for creating fleets, triggering sorties, and inspecting state.
 */

export class EngineAPI {
  private baseUrl: string;

  constructor(port: number) {
    this.baseUrl = `http://localhost:${port}`;
  }

  private async post(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return (await res.json()) as Record<string, unknown>;
  }

  private async get(path: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}${path}`);
    return (await res.json()) as Record<string, unknown>;
  }

  private async del(path: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}${path}`, { method: "DELETE" });
    return (await res.json()) as Record<string, unknown>;
  }

  // --- Fleet operations ---

  async listFleets(): Promise<Record<string, unknown>[]> {
    // Fleets are managed via WS, not REST. Use the ships endpoint to check health.
    return [];
  }

  // --- Ship operations ---

  async getShips(
    fleetId?: string,
  ): Promise<Record<string, unknown>> {
    const query = fleetId ? `?fleetId=${fleetId}` : "";
    return this.get(`/api/ships${query}`);
  }

  async getShip(shipId: string): Promise<Record<string, unknown>> {
    return this.get(`/api/ships/${shipId}`);
  }

  async getShipPhase(
    shipId: string,
  ): Promise<{ ok: boolean; phase: string }> {
    return this.get(`/api/ship/${shipId}/phase`) as Promise<{
      ok: boolean;
      phase: string;
    }>;
  }

  async sortie(
    fleetId: string,
    items: Array<{ repo: string; issueNumber: number }>,
  ): Promise<Record<string, unknown>> {
    return this.post("/api/sortie", { fleetId, items });
  }

  async pauseShip(shipId: string): Promise<Record<string, unknown>> {
    return this.post(`/api/ship-pause`, { shipId });
  }

  async resumeShip(shipId: string): Promise<Record<string, unknown>> {
    return this.post(`/api/ship-resume`, { shipId });
  }

  async abandonShip(shipId: string): Promise<Record<string, unknown>> {
    return this.post(`/api/ship-abandon`, { shipId });
  }

  async resumeAll(): Promise<Record<string, unknown>> {
    return this.post("/api/resume-all");
  }

  async deleteShip(shipId: string): Promise<Record<string, unknown>> {
    return this.del(`/api/ship/${shipId}/delete`);
  }

  // --- Phase inspection ---

  async getPhaseTransitionLog(
    shipId: string,
    limit = 10,
  ): Promise<Record<string, unknown>> {
    return this.get(
      `/api/ship/${shipId}/phase-transition-log?limit=${limit}`,
    );
  }

  // --- Health check ---

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/ships`);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Wait for a Ship to reach a target phase.
   * Polls the phase endpoint until the target is reached or timeout.
   */
  async waitForPhase(
    shipId: string,
    target: string | string[],
    timeoutMs = 60_000,
  ): Promise<string> {
    const targets = Array.isArray(target) ? target : [target];
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = await this.getShipPhase(shipId);
      if (targets.includes(result.phase)) return result.phase;
      if (["done", "paused", "abandoned"].some((s) => result.phase === s && !targets.includes(s))) {
        return result.phase; // Terminal state reached unexpectedly
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(
      `Timeout waiting for ship ${shipId} to reach phase ${targets.join("|")} (${timeoutMs}ms)`,
    );
  }
}
