import {
  test,
  expect,
  waitForConnection,
  createAndSelectFleet,
} from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * Sortie Focus Stability E2E Tests — Issue #671
 *
 * Validates that `focusedSessionId` does NOT change when a Ship is sortied.
 * The key difference from chat-preservation.spec.ts is that this test uses
 * the correct `{ shipId }` message format (matching the real Engine) and
 * mocks the `GET /api/ships/:id` endpoint so that the full code path
 * (`updateShipFromApi` → `syncShips` → `registerSession`) is exercised.
 *
 * Previous tests used `{ id }` in ship:created messages, which meant
 * `updateShipFromApi(undefined)` failed silently and `registerSession`
 * was never called — leaving the real sortie flow untested.
 */

// ---------------------------------------------------------------------------
// Simulated ship data
// ---------------------------------------------------------------------------

const SHIP_1 = {
  id: "e2e-focus-ship-001",
  repo: "mizunowanko-org/toy-admiral-test",
  issueNumber: 671,
  issueTitle: "Focus stability test ship 1",
  branchName: "feature/671-focus-test-1",
};

const SHIP_2 = {
  id: "e2e-focus-ship-002",
  repo: "mizunowanko-org/toy-admiral-test",
  issueNumber: 672,
  issueTitle: "Focus stability test ship 2",
  branchName: "feature/672-focus-test-2",
};

// ---------------------------------------------------------------------------
// WebSocket capture
// ---------------------------------------------------------------------------

async function installWsCapture(page: Page) {
  await page.addInitScript(() => {
    const OriginalWebSocket = window.WebSocket;
    const captured: WebSocket[] = [];
    (window as unknown as Record<string, unknown>).__capturedWs = captured;

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

async function injectWsMessage(page: Page, message: Record<string, unknown>) {
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the fleet ID of the currently selected fleet from the sidebar. */
async function getSelectedFleetId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const btn = document.querySelector("button.bg-accent");
    return btn?.getAttribute("data-fleet-id") ?? "";
  });
}

/** Switch to the Dock tab and return the Dock input locator. */
async function switchToDock(page: Page) {
  const dockTab = page.getByRole("button", { name: /dock/i });
  await expect(dockTab).toBeVisible({ timeout: 5000 });
  await dockTab.click();

  const dockInput = page.getByPlaceholder("Send a command to Dock...");
  await expect(dockInput).toBeVisible({ timeout: 5000 });
  return dockInput;
}

/**
 * Build a mock Ship API response for `GET /api/ships/:id`.
 * Returns the shape that `api-client.ts` expects: `{ ok: true, ships: [ship] }`.
 */
function buildShipApiResponse(
  shipDef: typeof SHIP_1,
  fleetId: string,
): string {
  return JSON.stringify({
    ok: true,
    ships: [
      {
        id: shipDef.id,
        fleetId,
        repo: shipDef.repo,
        issueNumber: shipDef.issueNumber,
        issueTitle: shipDef.issueTitle,
        phase: "planning",
        branchName: shipDef.branchName,
        worktreePath: `/tmp/e2e-worktree/${shipDef.id}`,
        sessionId: null,
        prUrl: null,
        prReviewStatus: null,
        gateCheck: null,
        isCompacting: false,
        retryCount: 0,
        createdAt: new Date().toISOString(),
      },
    ],
  });
}

/**
 * Mock the `GET /api/ships/:id` endpoint so that `updateShipFromApi`
 * succeeds and the full `syncShips` → `registerSession` chain fires.
 */
async function mockShipApi(
  page: Page,
  shipDef: typeof SHIP_1,
  fleetId: string,
) {
  await page.route(`**/api/ships/${shipDef.id}`, (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: buildShipApiResponse(shipDef, fleetId),
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Sortie Focus Stability — Issue #671", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    await installWsCapture(page);
  });

  // ── Scenario 1: Dock フォーカス中に sortie → Dock のまま ──
  test("Scenario 1: focusedSessionId stays on Dock after ship:created with full API chain", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForConnection(page);
    await createAndSelectFleet(page, "Focus Stability Test 1");

    const fleetId = await getSelectedFleetId(page);

    // Mock the ship API before injecting the WS message
    await mockShipApi(page, SHIP_1, fleetId);

    // Switch to Dock
    const dockInput = await switchToDock(page);
    const testText = "Dock のアタシの入力！sortie しても消えないよ！";
    await dockInput.fill(testText);
    await expect(dockInput).toHaveValue(testText);

    // Record which session is focused (should be dock-<fleetId>)
    const dockPlaceholder = "Send a command to Dock...";
    await expect(page.getByPlaceholder(dockPlaceholder)).toBeVisible();

    // ── Simulate Sortie: ship:created with correct { shipId } format ──
    await injectWsMessage(page, {
      type: "ship:created",
      data: { shipId: SHIP_1.id },
    });

    // Wait 1s to catch race conditions (per issue guidance)
    await page.waitForTimeout(1000);

    // ── Assertions ──
    // 1. Dock input is still visible (focus didn't jump to Flagship)
    await expect(page.getByPlaceholder(dockPlaceholder)).toBeVisible({
      timeout: 3000,
    });

    // 2. Input text preserved
    await expect(dockInput).toHaveValue(testText, { timeout: 3000 });

    // 3. Flagship input is NOT visible (confirming we're still on Dock)
    await expect(
      page.getByPlaceholder("Send a command to Flagship..."),
    ).not.toBeVisible();
  });

  // ── Scenario 2: Flagship フォーカス中に sortie → Flagship のまま ──
  test("Scenario 2: focusedSessionId stays on Flagship after ship:created", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForConnection(page);
    await createAndSelectFleet(page, "Focus Stability Test 2");

    const fleetId = await getSelectedFleetId(page);
    await mockShipApi(page, SHIP_1, fleetId);

    // Stay on Flagship (default after fleet creation)
    const flagshipInput = page.getByPlaceholder(
      "Send a command to Flagship...",
    );
    await expect(flagshipInput).toBeVisible({ timeout: 5000 });

    const testText = "Flagship の入力も安定してるはず！";
    await flagshipInput.fill(testText);
    await expect(flagshipInput).toHaveValue(testText);

    // ── Simulate Sortie ──
    await injectWsMessage(page, {
      type: "ship:created",
      data: { shipId: SHIP_1.id },
    });

    await page.waitForTimeout(1000);

    // ── Assertions ──
    await expect(flagshipInput).toBeVisible({ timeout: 3000 });
    await expect(flagshipInput).toHaveValue(testText, { timeout: 3000 });
  });

  // ── Scenario 3: 複数 sortie 連発 → フォーカス安定 ──
  test("Scenario 3: focusedSessionId stable across multiple rapid sorties", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForConnection(page);
    await createAndSelectFleet(page, "Focus Stability Test 3");

    const fleetId = await getSelectedFleetId(page);
    await mockShipApi(page, SHIP_1, fleetId);
    await mockShipApi(page, SHIP_2, fleetId);

    // Switch to Dock
    const dockInput = await switchToDock(page);
    const testText = "連続 sortie でも安定！";
    await dockInput.fill(testText);
    await expect(dockInput).toHaveValue(testText);

    // ── Sortie 1st Ship ──
    await injectWsMessage(page, {
      type: "ship:created",
      data: { shipId: SHIP_1.id },
    });

    await page.waitForTimeout(1000);

    // Verify Dock still focused
    await expect(dockInput).toBeVisible({ timeout: 3000 });
    await expect(dockInput).toHaveValue(testText, { timeout: 3000 });

    // ── Sortie 2nd Ship (rapid succession) ──
    await injectWsMessage(page, {
      type: "ship:created",
      data: { shipId: SHIP_2.id },
    });

    await page.waitForTimeout(1000);

    // ── Assertions ──
    // Dock input still visible and preserved
    await expect(dockInput).toBeVisible({ timeout: 3000 });
    await expect(dockInput).toHaveValue(testText, { timeout: 3000 });

    // Flagship NOT visible
    await expect(
      page.getByPlaceholder("Send a command to Flagship..."),
    ).not.toBeVisible();
  });
});
