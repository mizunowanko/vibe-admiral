import type { Ship } from "@/types";

const BASE_URL = "/api";

interface ApiResponse<T = unknown> {
  ok: boolean;
  error?: string;
  result?: string;
  ships?: T;
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
