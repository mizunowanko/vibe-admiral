/**
 * Shared WebSocket helpers for E2E tests.
 *
 * Extracted from ship-state-stability.spec.ts patterns.
 * Provides WS capture (monkey-patch), message injection,
 * and message waiting utilities.
 */

import type { Page } from "@playwright/test";

/**
 * Install a WebSocket wrapper via addInitScript so we can capture the app's
 * WebSocket instance before any application code runs.
 * Must be called BEFORE page.goto().
 */
export async function installWsCapture(page: Page) {
  await page.addInitScript(() => {
    const OriginalWebSocket = window.WebSocket;
    const captured: WebSocket[] = [];
    (window as unknown as Record<string, unknown>).__capturedWs = captured;

    // @ts-expect-error — intentional monkey-patch
    window.WebSocket = function PatchedWebSocket(
      this: WebSocket,
      url: string | URL,
      protocols?: string | string[],
    ) {
      const ws = new OriginalWebSocket(url, protocols);
      captured.push(ws);
      return ws;
    } as unknown as typeof WebSocket;
    window.WebSocket.prototype = OriginalWebSocket.prototype;
    Object.defineProperty(window.WebSocket, "CONNECTING", { value: 0 });
    Object.defineProperty(window.WebSocket, "OPEN", { value: 1 });
    Object.defineProperty(window.WebSocket, "CLOSING", { value: 2 });
    Object.defineProperty(window.WebSocket, "CLOSED", { value: 3 });
  });
}

/**
 * Dispatch a message on the app's captured WebSocket instance.
 * Triggers the same onmessage handler that ws-client uses.
 */
export async function injectWsMessage(
  page: Page,
  message: Record<string, unknown>,
) {
  await page.evaluate((msg) => {
    const captured = (window as unknown as Record<string, WebSocket[]>)
      .__capturedWs;
    const ws = captured?.find((w) => w.readyState === WebSocket.OPEN);
    if (ws) {
      ws.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(msg) }),
      );
    } else {
      console.warn("[e2e] No open WebSocket found for message injection");
    }
  }, message);
}

/**
 * Wait for a specific WS message type to arrive.
 * Installs a temporary message listener and resolves when matched.
 */
export async function waitForWsMessage(
  page: Page,
  type: string,
  predicate?: (data: Record<string, unknown>) => boolean,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  return page.evaluate(
    ({ type, timeoutMs }) => {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const captured = (window as unknown as Record<string, WebSocket[]>)
          .__capturedWs;
        const ws = captured?.find((w) => w.readyState === WebSocket.OPEN);
        if (!ws) {
          reject(new Error("No open WebSocket"));
          return;
        }

        const timer = setTimeout(() => {
          ws.removeEventListener("message", handler);
          reject(new Error(`Timeout waiting for WS message type: ${type}`));
        }, timeoutMs);

        function handler(event: MessageEvent) {
          try {
            const data = JSON.parse(event.data);
            if (data.type === type) {
              clearTimeout(timer);
              ws!.removeEventListener("message", handler);
              resolve(data);
            }
          } catch {
            // ignore parse errors
          }
        }

        ws.addEventListener("message", handler);
      });
    },
    { type, timeoutMs },
  );
}
