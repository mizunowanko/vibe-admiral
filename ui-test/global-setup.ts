import { MockEngine } from "./mock-engine";

let mockEngine: MockEngine;

export default async function globalSetup() {
  mockEngine = new MockEngine(9721);
  // Store reference for teardown
  (globalThis as Record<string, unknown>).__mockEngine = mockEngine;
}
