export function safeJsonParse<T>(
  raw: string | null | undefined,
  ctx: string,
  fallback: T,
): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.warn(
      `[db] Failed to parse JSON (${ctx}): ${e instanceof Error ? e.message : e}`,
    );
    return fallback;
  }
}
