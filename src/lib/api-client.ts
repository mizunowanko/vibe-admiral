import type { Ship } from "@/types";

const BASE_URL = "/api";

interface ApiResponse<T = unknown> {
  ok: boolean;
  error?: string;
  result?: string;
  ships?: T;
}

export interface ResumeAllResult {
  type: "ship" | "flagship" | "dock";
  id: string;
  fleetId: string;
  label: string;
  status: "resumed" | "skipped" | "error";
  reason?: string;
}

interface ResumeAllResponse {
  ok: boolean;
  error?: string;
  results: ResumeAllResult[];
  summary: { resumed: number; skipped: number; errors: number };
}

async function request<T>(
  path: string,
  options?: RequestInit,
): Promise<ApiResponse<T>> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  return res.json() as Promise<ApiResponse<T>>;
}

export async function fetchShips(fleetId?: string): Promise<Ship[]> {
  const params = fleetId ? `?fleetId=${encodeURIComponent(fleetId)}` : "";
  const data = await request<Ship[]>(`/ships${params}`);
  return data.ships ?? [];
}

export async function fetchShip(shipId: string): Promise<Ship | null> {
  const data = await request<Ship[]>(`/ships/${encodeURIComponent(shipId)}`);
  const ships = data.ships ?? [];
  return ships[0] ?? null;
}

export async function sortie(
  fleetId: string,
  repo: string,
  issueNumber: number,
): Promise<string> {
  const data = await request(`/sortie`, {
    method: "POST",
    body: JSON.stringify({ fleetId, items: [{ repo, issueNumber }] }),
  });
  if (!data.ok) throw new Error(data.error ?? "Sortie failed");
  return data.result ?? "OK";
}

export async function pauseShip(
  shipId: string,
  fleetId?: string,
): Promise<string> {
  const data = await request(`/ship-pause`, {
    method: "POST",
    body: JSON.stringify({ shipId, fleetId }),
  });
  if (!data.ok) throw new Error(data.error ?? "Pause failed");
  return data.result ?? "OK";
}

export async function resumeShip(
  shipId: string,
  fleetId?: string,
): Promise<string> {
  const data = await request(`/ship-resume`, {
    method: "POST",
    body: JSON.stringify({ shipId, fleetId }),
  });
  if (!data.ok) throw new Error(data.error ?? "Resume failed");
  return data.result ?? "OK";
}

export async function abandonShip(
  shipId: string,
  fleetId?: string,
): Promise<string> {
  const data = await request(`/ship-abandon`, {
    method: "POST",
    body: JSON.stringify({ shipId, fleetId }),
  });
  if (!data.ok) throw new Error(data.error ?? "Abandon failed");
  return data.result ?? "OK";
}

export async function reactivateShip(
  shipId: string,
  fleetId?: string,
): Promise<string> {
  const data = await request(`/ship-reactivate`, {
    method: "POST",
    body: JSON.stringify({ shipId, fleetId }),
  });
  if (!data.ok) throw new Error(data.error ?? "Reactivate failed");
  return data.result ?? "OK";
}

export async function restartEngine(): Promise<ApiResponse> {
  const data = await request("/restart", { method: "POST" });
  if (!data.ok) throw new Error(data.error ?? "Restart failed");
  return data;
}

export async function resumeAll(): Promise<ResumeAllResponse> {
  const res = await fetch(`${BASE_URL}/resume-all`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const data = (await res.json()) as ResumeAllResponse;
  if (!data.ok) throw new Error(data.error ?? "Resume all failed");
  return data;
}
