const PORT_MANAGER_URL = "http://127.0.0.1:53100";

export async function allocatePort(): Promise<number> {
  const res = await fetch(`${PORT_MANAGER_URL}/allocate`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to allocate port: ${res.statusText}`);
  const data = (await res.json()) as { port: number };
  return data.port;
}

export async function releasePort(port: number): Promise<void> {
  await fetch(`${PORT_MANAGER_URL}/release`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ port }),
  });
}

export async function isAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${PORT_MANAGER_URL}/status`);
    return res.ok;
  } catch {
    return false;
  }
}
