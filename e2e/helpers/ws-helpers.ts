/**
 * Shared WebSocket helpers for E2E tests.
 *
 * Extracted from ship-state-stability.spec.ts patterns.
 * Provides WS capture (monkey-patch), message injection,
 * and message waiting utilities.
 *
 * Since ADR-0019, WS messages are notification-only — the frontend
 * fetches full data via REST API on receiving ship:created / ship:updated.
 * `seedShip()` + `injectShipNotification()` handle this by intercepting
 * the REST fetch and dispatching the correct WS notification.
 */

import type { Page } from "@playwright/test";

/** Ship seed data for E2E tests. */
export interface ShipSeed {
  id: string;
  fleetId: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  branchName: string;
  phase: string;
  worktreePath?: string;
  sessionId?: string | null;
  prUrl?: string | null;
  prReviewStatus?: string | null;
  gateCheck?: unknown;
  retryCount?: number;
  isCompacting?: boolean;
  processDead?: boolean;
  createdAt?: string;
}

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
    // Find the app's WSClient connection (path ends with /ws)
    const appWs = captured?.find(
      (w) => w.readyState === WebSocket.OPEN && w.url.endsWith("/ws"),
    );
    if (appWs) {
      const event = new MessageEvent("message", { data: JSON.stringify(msg) });
      if (typeof appWs.onmessage === "function") {
        appWs.onmessage(event);
      }
      appWs.dispatchEvent(event);
    } else {
      console.warn("[e2e] No open WebSocket found for message injection");
    }
  }, message);
}

// ---------------------------------------------------------------------------
// Ship seeding — notification-only WS protocol (ADR-0019)
// ---------------------------------------------------------------------------

// Per-page registry of seeded ships. Playwright route handlers use this
// to return correct data for `/api/ships/:id` fetches triggered by the
// frontend's `updateShipFromApi()`.
const pageShipSeeds = new WeakMap<Page, Map<string, ShipSeed>>();

function getSeeds(page: Page): Map<string, ShipSeed> {
  let seeds = pageShipSeeds.get(page);
  if (!seeds) {
    seeds = new Map();
    pageShipSeeds.set(page, seeds);
  }
  return seeds;
}

/**
 * Register a Playwright route that intercepts `/api/ships/:id` requests
 * and returns seeded ship data. Call once per page, before seedShip().
 */
export async function installShipSeedRoute(page: Page) {
  // Intercept /api/ships/:id requests. The glob must match the full URL
  // as seen by the browser (e.g. http://localhost:PORT/api/ships/SHIP_ID).
  await page.route(/\/api\/ships\/[^/?]+$/, async (route, request) => {
    const url = new URL(request.url());
    const segments = url.pathname.split("/");
    const shipId = segments[segments.length - 1];
    const seeds = getSeeds(page);
    const seed = shipId ? seeds.get(shipId) : undefined;

    if (seed) {
      const ship = {
        id: seed.id,
        fleetId: seed.fleetId,
        repo: seed.repo,
        issueNumber: seed.issueNumber,
        issueTitle: seed.issueTitle,
        branchName: seed.branchName,
        phase: seed.phase,
        worktreePath: seed.worktreePath ?? "",
        sessionId: seed.sessionId ?? null,
        prUrl: seed.prUrl ?? null,
        prReviewStatus: seed.prReviewStatus ?? null,
        gateCheck: seed.gateCheck ?? null,
        retryCount: seed.retryCount ?? 0,
        isCompacting: seed.isCompacting ?? false,
        processDead: seed.processDead ?? false,
        createdAt: seed.createdAt ?? new Date().toISOString(),
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, ships: [ship] }),
      });
    } else {
      // Let it through to the real Engine
      await route.continue();
    }
  });
}

/**
 * Seed a ship into the test registry and inject a `ship:created` WS
 * notification so the frontend fetches it from the intercepted route.
 *
 * Equivalent to what the real Engine does: insert to DB → broadcast
 * `ship:created { shipId }` → frontend calls GET /api/ships/:id.
 */
export async function seedShip(page: Page, ship: ShipSeed) {
  getSeeds(page).set(ship.id, ship);

  await injectWsMessage(page, {
    type: "ship:created",
    data: { shipId: ship.id },
  });
  // Allow the frontend to process the WS message and fetch from the route
  await page.waitForTimeout(500);
}

/**
 * Update a seeded ship's phase (or other fields) and inject a
 * `ship:updated` WS notification.
 */
export async function updateSeededShip(
  page: Page,
  shipId: string,
  updates: Partial<ShipSeed>,
) {
  const seeds = getSeeds(page);
  const existing = seeds.get(shipId);
  if (existing) {
    seeds.set(shipId, { ...existing, ...updates });
  }
  await injectWsMessage(page, {
    type: "ship:updated",
    data: { shipId },
  });
  await page.waitForTimeout(200);
}

/**
 * Mark a seeded ship as done and inject a `ship:done` WS notification.
 */
export async function completeSeededShip(page: Page, shipId: string) {
  const seeds = getSeeds(page);
  const existing = seeds.get(shipId);
  if (existing) {
    seeds.set(shipId, { ...existing, phase: "done" });
  }
  await injectWsMessage(page, {
    type: "ship:done",
    data: { shipId },
  });
  await page.waitForTimeout(200);
}

/**
 * Inject a gate-pending notification for a seeded ship.
 */
export async function injectGatePending(
  page: Page,
  shipId: string,
  gatePhase: string,
  gateType: string,
  fleetId: string,
  issueNumber: number,
  issueTitle: string,
) {
  await injectWsMessage(page, {
    type: "ship:gate-pending",
    data: { id: shipId, gatePhase, gateType, fleetId, issueNumber, issueTitle },
  });
  await page.waitForTimeout(200);
}

/**
 * Inject a gate-resolved notification for a seeded ship.
 */
export async function injectGateResolved(
  page: Page,
  shipId: string,
  gatePhase: string,
  gateType: string,
  approved: boolean,
  feedback?: string,
) {
  await injectWsMessage(page, {
    type: "ship:gate-resolved",
    data: { id: shipId, gatePhase, gateType, approved, feedback },
  });
  await page.waitForTimeout(200);
}

/**
 * Get the selected fleet ID from the page's fleet store.
 */
export async function getSelectedFleetId(page: Page): Promise<string> {
  // The fleetStore persists selectedFleetId under "admiral-fleet" key.
  return page.evaluate(() => {
    try {
      const stored = localStorage.getItem("admiral-fleet");
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed?.state?.selectedFleetId) return parsed.state.selectedFleetId as string;
      }
    } catch { /* ignore */ }
    return "";
  });
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
