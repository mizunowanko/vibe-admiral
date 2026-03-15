export default async function globalTeardown() {
  const engine = (globalThis as Record<string, unknown>).__mockEngine as {
    close: () => Promise<void>;
  } | undefined;
  if (engine) {
    await engine.close();
  }
}
