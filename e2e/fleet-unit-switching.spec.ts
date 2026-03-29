import {
  test,
  expect,
  waitForConnection,
  createAndSelectFleet,
} from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * Fleet/Unit Switching E2E Tests — Issue #681
 *
 * Comprehensive tests for Fleet switching and Unit (Dock/Flagship/Ship)
 * switching to detect chat contamination bugs. Each scenario verifies that
 * messages belong to the correct Fleet+Unit and that no cross-contamination
 * occurs.
 *
 * Key constraint: useCommander stores messages in React local state. Only the
 * focused session's hook is mounted, so messages must be injected while the
 * target session is active. Round-trip tests inject fresh messages after
 * returning to verify no contamination from other sessions.
 *
 * Test groups:
 *   A. Fleet inter-navigation
 *   B. Unit intra-navigation (within a Fleet)
 *   C. Fleet x Unit composite navigation
 *   D. Navigation during Sortie
 */

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
    // Find the Engine WebSocket (URL ends with /ws), not Vite HMR
    const ws = captured?.find(
      (w) => w.readyState === WebSocket.OPEN && w.url.endsWith("/ws"),
    );
    if (ws) {
      ws.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(msg) }),
      );
    } else {
      console.warn("[e2e] No Engine WebSocket found for message injection");
    }
  }, message);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the fleet ID of the currently selected fleet from Zustand persist store. */
async function getSelectedFleetId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const stored = localStorage.getItem("admiral-fleet");
    if (!stored) return "";
    try {
      const parsed = JSON.parse(stored);
      return parsed.state?.selectedFleetId ?? "";
    } catch {
      return "";
    }
  });
}

/** Switch to the Dock tab. */
async function switchToDock(page: Page) {
  const dockTab = page.getByRole("button", { name: /dock/i });
  await expect(dockTab).toBeVisible({ timeout: 5000 });
  await dockTab.click();
  await expect(
    page.getByPlaceholder("Send a command to Dock..."),
  ).toBeVisible({ timeout: 5000 });
}

/** Switch to the Flagship tab. */
async function switchToFlagship(page: Page) {
  const flagshipTab = page.getByRole("button", { name: /flagship/i });
  await expect(flagshipTab).toBeVisible({ timeout: 5000 });
  await flagshipTab.click();
  await expect(
    page.getByPlaceholder("Send a command to Flagship..."),
  ).toBeVisible({ timeout: 5000 });
}

/** Select a Fleet by name in the sidebar. */
async function selectFleet(page: Page, name: string) {
  const btn = page.locator("button").filter({ hasText: name });
  await btn.click();
  await page.waitForTimeout(500);
}

/** Inject a commander stream message (dock or flagship). */
async function injectCommanderMessage(
  page: Page,
  role: "dock" | "flagship",
  fleetId: string,
  content: string,
) {
  await injectWsMessage(page, {
    type: `${role}:stream`,
    data: {
      fleetId,
      message: {
        type: "assistant",
        content,
        timestamp: Date.now(),
      },
    },
  });
}

/** Verify that the given text is visible on the page. */
async function assertMessageVisible(page: Page, text: string) {
  await expect(page.getByText(text, { exact: false })).toBeVisible({
    timeout: 5000,
  });
}

/** Verify that the given text is NOT visible on the page. */
async function assertMessageNotVisible(page: Page, text: string) {
  await expect(
    page.getByText(text, { exact: false }),
  ).not.toBeVisible({ timeout: 3000 });
}

/** Verify that Dock input is active (focused session is Dock). */
async function assertDockActive(page: Page) {
  await expect(
    page.getByPlaceholder("Send a command to Dock..."),
  ).toBeVisible({ timeout: 5000 });
}

/** Verify that Flagship input is active (focused session is Flagship). */
async function assertFlagshipActive(page: Page) {
  await expect(
    page.getByPlaceholder("Send a command to Flagship..."),
  ).toBeVisible({ timeout: 5000 });
}

/** Verify input field is empty (no draft contamination). */
async function assertInputEmpty(page: Page) {
  const textarea = page.locator(
    "textarea[placeholder*='Send a command']",
  );
  await expect(textarea).toBeVisible({ timeout: 5000 });
  await expect(textarea).toHaveValue("");
}

// ===========================================================================
// A. Fleet Inter-Navigation
// ===========================================================================

test.describe("A. Fleet Inter-Navigation — Issue #681", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    await installWsCapture(page);
  });

  // A1: Fleet A (Dock) → Fleet B (Dock)
  test("A1: Fleet A (Dock) → Fleet B (Dock) — Fleet B Dock chat displayed", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForConnection(page);

    await createAndSelectFleet(page, "A1-Alpha");
    const fleetAId = await getSelectedFleetId(page);
    await switchToDock(page);
    await injectCommanderMessage(page, "dock", fleetAId, "[A1-DOCK-A] Fleet A Dock message");
    await assertMessageVisible(page, "[A1-DOCK-A]");

    await page.waitForTimeout(1000);

    // Switch to Fleet B
    await createAndSelectFleet(page, "A1-Bravo");
    const fleetBId = await getSelectedFleetId(page);
    await switchToDock(page);
    await injectCommanderMessage(page, "dock", fleetBId, "[A1-DOCK-B] Fleet B Dock message");

    await page.waitForTimeout(1000);

    await assertDockActive(page);
    await assertMessageVisible(page, "[A1-DOCK-B]");
    await assertMessageNotVisible(page, "[A1-DOCK-A]");
    await assertInputEmpty(page);
  });

  // A2: Fleet A (Flagship) → Fleet B (Flagship)
  test("A2: Fleet A (Flagship) → Fleet B (Flagship) — Fleet B Flagship chat displayed", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForConnection(page);

    await createAndSelectFleet(page, "A2-Alpha");
    const fleetAId = await getSelectedFleetId(page);
    await injectCommanderMessage(page, "flagship", fleetAId, "[A2-FLAG-A] Fleet A Flagship msg");
    await assertMessageVisible(page, "[A2-FLAG-A]");

    await page.waitForTimeout(1000);

    await createAndSelectFleet(page, "A2-Bravo");
    const fleetBId = await getSelectedFleetId(page);
    await injectCommanderMessage(page, "flagship", fleetBId, "[A2-FLAG-B] Fleet B Flagship msg");

    await page.waitForTimeout(1000);

    await assertFlagshipActive(page);
    await assertMessageVisible(page, "[A2-FLAG-B]");
    await assertMessageNotVisible(page, "[A2-FLAG-A]");
    await assertInputEmpty(page);
  });

  // A3: Fleet A (Dock) → Fleet B (Flagship)
  test("A3: Fleet A (Dock) → Fleet B (Flagship) — Fleet B Flagship chat displayed", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForConnection(page);

    await createAndSelectFleet(page, "A3-Alpha");
    const fleetAId = await getSelectedFleetId(page);
    await switchToDock(page);
    await injectCommanderMessage(page, "dock", fleetAId, "[A3-DOCK-A] Fleet A Dock msg");
    await assertMessageVisible(page, "[A3-DOCK-A]");

    await page.waitForTimeout(1000);

    await createAndSelectFleet(page, "A3-Bravo");
    const fleetBId = await getSelectedFleetId(page);
    await injectCommanderMessage(page, "flagship", fleetBId, "[A3-FLAG-B] Fleet B Flagship msg");

    await page.waitForTimeout(1000);

    await assertFlagshipActive(page);
    await assertMessageVisible(page, "[A3-FLAG-B]");
    await assertMessageNotVisible(page, "[A3-DOCK-A]");
    await assertInputEmpty(page);
  });

  // A4: Fleet A → Fleet B → Fleet A — round-trip
  test("A4: Fleet A → Fleet B → Fleet A — no Fleet B contamination after round-trip", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForConnection(page);

    await createAndSelectFleet(page, "A4-Alpha");
    const fleetAId = await getSelectedFleetId(page);
    await injectCommanderMessage(page, "flagship", fleetAId, "[A4-FLAG-A] Fleet A original msg");
    await assertMessageVisible(page, "[A4-FLAG-A]");

    await page.waitForTimeout(1000);

    // Switch to Fleet B
    await createAndSelectFleet(page, "A4-Bravo");
    const fleetBId = await getSelectedFleetId(page);
    await injectCommanderMessage(page, "flagship", fleetBId, "[A4-FLAG-B] Fleet B msg");

    await page.waitForTimeout(1000);

    await assertMessageVisible(page, "[A4-FLAG-B]");
    await assertMessageNotVisible(page, "[A4-FLAG-A]");

    // Switch back to Fleet A
    await selectFleet(page, "A4-Alpha");
    await page.waitForTimeout(1000);

    // Inject a fresh message to verify routing is correct
    const fleetAIdAgain = await getSelectedFleetId(page);
    await injectCommanderMessage(page, "flagship", fleetAIdAgain, "[A4-FLAG-A2] Fleet A after return");

    await page.waitForTimeout(1000);

    await assertFlagshipActive(page);
    await assertMessageVisible(page, "[A4-FLAG-A2]");
    await assertMessageNotVisible(page, "[A4-FLAG-B]");
  });

  // A5: Fleet A → Fleet B → Fleet C → Fleet A — 3-fleet round-trip
  test("A5: Fleet A → B → C → A — 3-fleet round-trip, no contamination", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForConnection(page);

    await createAndSelectFleet(page, "A5-Alpha");
    const fleetAId = await getSelectedFleetId(page);
    await injectCommanderMessage(page, "flagship", fleetAId, "[A5-A] Fleet A msg");
    await assertMessageVisible(page, "[A5-A]");

    await page.waitForTimeout(1000);

    await createAndSelectFleet(page, "A5-Bravo");
    const fleetBId = await getSelectedFleetId(page);
    await injectCommanderMessage(page, "flagship", fleetBId, "[A5-B] Fleet B msg");
    await assertMessageVisible(page, "[A5-B]");
    await assertMessageNotVisible(page, "[A5-A]");

    await page.waitForTimeout(1000);

    await createAndSelectFleet(page, "A5-Charlie");
    const fleetCId = await getSelectedFleetId(page);
    await injectCommanderMessage(page, "flagship", fleetCId, "[A5-C] Fleet C msg");
    await assertMessageVisible(page, "[A5-C]");
    await assertMessageNotVisible(page, "[A5-A]");
    await assertMessageNotVisible(page, "[A5-B]");

    await page.waitForTimeout(1000);

    // Return to Fleet A — inject fresh message to verify correct routing
    await selectFleet(page, "A5-Alpha");
    await page.waitForTimeout(1000);
    const fleetAIdAgain = await getSelectedFleetId(page);
    await injectCommanderMessage(page, "flagship", fleetAIdAgain, "[A5-A2] Fleet A after 3-fleet cycle");

    await page.waitForTimeout(1000);

    await assertFlagshipActive(page);
    await assertMessageVisible(page, "[A5-A2]");
    await assertMessageNotVisible(page, "[A5-B]");
    await assertMessageNotVisible(page, "[A5-C]");
  });
});

// ===========================================================================
// B. Unit Intra-Navigation (within a single Fleet)
// ===========================================================================

test.describe("B. Unit Intra-Navigation — Issue #681", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    await installWsCapture(page);
  });

  // B1: Dock → Flagship
  test("B1: Dock → Flagship — Flagship chat only displayed", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForConnection(page);

    await createAndSelectFleet(page, "B1-Fleet");
    const fleetId = await getSelectedFleetId(page);

    // Inject Flagship message while Flagship is focused (default)
    await injectCommanderMessage(page, "flagship", fleetId, "[B1-FLAG] Flagship message");
    await assertMessageVisible(page, "[B1-FLAG]");

    // Switch to Dock, inject Dock message
    await switchToDock(page);
    await injectCommanderMessage(page, "dock", fleetId, "[B1-DOCK] Dock message");
    await assertMessageVisible(page, "[B1-DOCK]");
    await assertMessageNotVisible(page, "[B1-FLAG]");

    await page.waitForTimeout(1000);

    // Switch to Flagship — inject fresh message to verify correct routing
    await switchToFlagship(page);
    await injectCommanderMessage(page, "flagship", fleetId, "[B1-FLAG2] Flagship after Dock");

    await page.waitForTimeout(1000);

    await assertFlagshipActive(page);
    await assertMessageVisible(page, "[B1-FLAG2]");
    await assertMessageNotVisible(page, "[B1-DOCK]");
    await assertInputEmpty(page);
  });

  // B2: Flagship → Dock
  test("B2: Flagship → Dock — Dock chat only displayed", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForConnection(page);

    await createAndSelectFleet(page, "B2-Fleet");
    const fleetId = await getSelectedFleetId(page);

    // Inject Flagship message (Flagship is default)
    await injectCommanderMessage(page, "flagship", fleetId, "[B2-FLAG] Flagship message");
    await assertMessageVisible(page, "[B2-FLAG]");

    await page.waitForTimeout(1000);

    // Switch to Dock, inject Dock message
    await switchToDock(page);
    await injectCommanderMessage(page, "dock", fleetId, "[B2-DOCK] Dock message");

    await page.waitForTimeout(1000);

    await assertDockActive(page);
    await assertMessageVisible(page, "[B2-DOCK]");
    await assertMessageNotVisible(page, "[B2-FLAG]");
    await assertInputEmpty(page);
  });

  // B3: Dock → Flagship → Dock
  test("B3: Dock → Flagship → Dock — no Flagship contamination", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForConnection(page);

    await createAndSelectFleet(page, "B3-Fleet");
    const fleetId = await getSelectedFleetId(page);

    // Start on Dock
    await switchToDock(page);
    await injectCommanderMessage(page, "dock", fleetId, "[B3-DOCK] Dock only msg");
    await assertMessageVisible(page, "[B3-DOCK]");

    await page.waitForTimeout(1000);

    // Switch to Flagship
    await switchToFlagship(page);
    await injectCommanderMessage(page, "flagship", fleetId, "[B3-FLAG] Flagship only msg");
    await assertMessageVisible(page, "[B3-FLAG]");
    await assertMessageNotVisible(page, "[B3-DOCK]");

    await page.waitForTimeout(1000);

    // Back to Dock — inject fresh message to verify no contamination
    await switchToDock(page);
    await injectCommanderMessage(page, "dock", fleetId, "[B3-DOCK2] Dock after round-trip");

    await page.waitForTimeout(1000);

    await assertDockActive(page);
    await assertMessageVisible(page, "[B3-DOCK2]");
    await assertMessageNotVisible(page, "[B3-FLAG]");
  });

  // B4: Dock → Ship → Dock
  test("B4: Dock → Ship → Dock — Ship messages don't contaminate Dock", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForConnection(page);

    await createAndSelectFleet(page, "B4-Fleet");
    const fleetId = await getSelectedFleetId(page);

    // Switch to Dock and inject message
    await switchToDock(page);
    await injectCommanderMessage(page, "dock", fleetId, "[B4-DOCK] Dock msg");
    await assertMessageVisible(page, "[B4-DOCK]");

    // Create a Ship using direct data format (like chat-preservation.spec.ts)
    const shipId = "e2e-b4-ship-001";
    await injectWsMessage(page, {
      type: "ship:created",
      data: {
        id: shipId,
        fleetId,
        repo: "mizunowanko-org/toy-admiral-test",
        issueNumber: 681,
        issueTitle: "B4 test ship",
        phase: "planning",
        branchName: "feature/681-b4-test",
      },
    });

    await page.waitForTimeout(1000);

    // Inject Ship message (goes to ship session, not visible on Dock)
    await injectWsMessage(page, {
      type: "ship:stream",
      data: {
        id: shipId,
        message: {
          type: "assistant",
          content: "[B4-SHIP] Ship message",
          timestamp: Date.now(),
        },
      },
    });

    await page.waitForTimeout(1000);

    // Still on Dock — Ship message should NOT be visible
    await assertDockActive(page);
    await assertMessageVisible(page, "[B4-DOCK]");
    await assertMessageNotVisible(page, "[B4-SHIP]");
  });

  // B5: Rapid toggle Dock ↔ Flagship x5
  test("B5: Rapid toggle Dock ↔ Flagship x5 — final selection wins", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForConnection(page);

    await createAndSelectFleet(page, "B5-Fleet");
    const fleetId = await getSelectedFleetId(page);

    // Rapid toggle 5 times with 200ms intervals
    for (let i = 0; i < 5; i++) {
      await switchToDock(page);
      await page.waitForTimeout(200);
      await switchToFlagship(page);
      await page.waitForTimeout(200);
    }

    // Final state: Flagship (last action was switchToFlagship)
    await page.waitForTimeout(1000);

    // Inject message to verify correct session is active
    await injectCommanderMessage(page, "flagship", fleetId, "[B5-FLAG] Flagship after rapid toggle");

    await assertFlagshipActive(page);
    await assertMessageVisible(page, "[B5-FLAG]");
    await assertInputEmpty(page);
  });
});

// ===========================================================================
// C. Fleet x Unit Composite Navigation
// ===========================================================================

test.describe("C. Fleet x Unit Composite Navigation — Issue #681", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    await installWsCapture(page);
  });

  // C1: Fleet A (Dock) → Fleet A (Flagship) → Fleet B (Dock)
  test("C1: Fleet A (Dock) → Fleet A (Flagship) → Fleet B (Dock) — Fleet B Dock only", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForConnection(page);

    await createAndSelectFleet(page, "Fleet-C1A");
    const fleetAId = await getSelectedFleetId(page);

    // Start on Dock
    await switchToDock(page);
    await injectCommanderMessage(page, "dock", fleetAId, "[C1-DOCK-A] Fleet A Dock");
    await assertMessageVisible(page, "[C1-DOCK-A]");

    await page.waitForTimeout(1000);

    // Switch to Flagship (same Fleet)
    await switchToFlagship(page);
    await injectCommanderMessage(page, "flagship", fleetAId, "[C1-FLAG-A] Fleet A Flagship");
    await assertMessageVisible(page, "[C1-FLAG-A]");
    await assertMessageNotVisible(page, "[C1-DOCK-A]");

    await page.waitForTimeout(1000);

    // Switch to Fleet B, Dock
    await createAndSelectFleet(page, "Fleet-C1B");
    const fleetBId = await getSelectedFleetId(page);
    await switchToDock(page);
    await injectCommanderMessage(page, "dock", fleetBId, "[C1-DOCK-B] Fleet B Dock");

    await page.waitForTimeout(1000);

    await assertDockActive(page);
    await assertMessageVisible(page, "[C1-DOCK-B]");
    await assertMessageNotVisible(page, "[C1-DOCK-A]");
    await assertMessageNotVisible(page, "[C1-FLAG-A]");
  });

  // C2: Fleet A (Flagship) → Fleet B (Dock) → Fleet A (Flagship)
  test("C2: Fleet A (Flagship) → Fleet B (Dock) → Fleet A (Flagship) — no Fleet B contamination", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForConnection(page);

    await createAndSelectFleet(page, "Fleet-C2A");
    const fleetAId = await getSelectedFleetId(page);
    await injectCommanderMessage(page, "flagship", fleetAId, "[C2-FLAG-A] Fleet A Flagship");
    await assertMessageVisible(page, "[C2-FLAG-A]");

    await page.waitForTimeout(1000);

    // Switch to Fleet B, Dock
    await createAndSelectFleet(page, "Fleet-C2B");
    const fleetBId = await getSelectedFleetId(page);
    await switchToDock(page);
    await injectCommanderMessage(page, "dock", fleetBId, "[C2-DOCK-B] Fleet B Dock");
    await assertMessageVisible(page, "[C2-DOCK-B]");

    await page.waitForTimeout(1000);

    // Return to Fleet A (auto-focuses Flagship)
    await selectFleet(page, "Fleet-C2A");
    await page.waitForTimeout(1000);

    // Inject fresh message to verify correct routing, no contamination
    const fleetAIdAgain = await getSelectedFleetId(page);
    await injectCommanderMessage(page, "flagship", fleetAIdAgain, "[C2-FLAG-A2] Fleet A after return");

    await assertFlagshipActive(page);
    await assertMessageVisible(page, "[C2-FLAG-A2]");
    await assertMessageNotVisible(page, "[C2-DOCK-B]");
  });

  // C3: Fleet A (Dock) → Fleet B (Flagship) → Fleet A (Dock) → Fleet B (Dock)
  test("C3: Fleet A (Dock) → Fleet B (Flagship) → Fleet A (Dock) → Fleet B (Dock) — each transition correct", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForConnection(page);

    await createAndSelectFleet(page, "Fleet-C3A");
    const fleetAId = await getSelectedFleetId(page);

    // Step 1: Fleet A Dock
    await switchToDock(page);
    await injectCommanderMessage(page, "dock", fleetAId, "[C3-DOCK-A] Fleet A Dock");
    await assertMessageVisible(page, "[C3-DOCK-A]");

    await page.waitForTimeout(1000);

    // Step 2: Fleet B Flagship
    await createAndSelectFleet(page, "Fleet-C3B");
    const fleetBId = await getSelectedFleetId(page);
    await injectCommanderMessage(page, "flagship", fleetBId, "[C3-FLAG-B] Fleet B Flagship");
    await assertMessageVisible(page, "[C3-FLAG-B]");
    await assertMessageNotVisible(page, "[C3-DOCK-A]");

    await page.waitForTimeout(1000);

    // Step 3: Return to Fleet A, Dock
    await selectFleet(page, "Fleet-C3A");
    await page.waitForTimeout(500);
    await switchToDock(page);
    const fleetAIdAgain = await getSelectedFleetId(page);
    await injectCommanderMessage(page, "dock", fleetAIdAgain, "[C3-DOCK-A2] Fleet A Dock after return");

    await page.waitForTimeout(1000);

    await assertDockActive(page);
    await assertMessageVisible(page, "[C3-DOCK-A2]");
    await assertMessageNotVisible(page, "[C3-FLAG-B]");

    // Step 4: Fleet B Dock
    await selectFleet(page, "Fleet-C3B");
    await page.waitForTimeout(500);
    await switchToDock(page);
    const fleetBIdAgain = await getSelectedFleetId(page);
    await injectCommanderMessage(page, "dock", fleetBIdAgain, "[C3-DOCK-B] Fleet B Dock");

    await page.waitForTimeout(1000);

    await assertDockActive(page);
    await assertMessageVisible(page, "[C3-DOCK-B]");
    await assertMessageNotVisible(page, "[C3-DOCK-A2]");
  });

  // C4: Fleet A Ship sortie → Fleet B → Fleet A
  test("C4: Fleet A Ship sortie → Fleet B → Fleet A — session restored", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForConnection(page);

    await createAndSelectFleet(page, "Fleet-C4A");
    const fleetAId = await getSelectedFleetId(page);

    // Sortie a Ship using direct data format
    const shipId = "e2e-c4-ship-001";
    await injectWsMessage(page, {
      type: "ship:created",
      data: {
        id: shipId,
        fleetId: fleetAId,
        repo: "mizunowanko-org/toy-admiral-test",
        issueNumber: 681,
        issueTitle: "C4 test ship",
        phase: "planning",
        branchName: "feature/681-c4-test",
      },
    });

    await page.waitForTimeout(1000);

    // Inject Flagship message after sortie
    await injectCommanderMessage(page, "flagship", fleetAId, "[C4-FLAG-A] Fleet A Flagship with sortie");
    await assertFlagshipActive(page);
    await assertMessageVisible(page, "[C4-FLAG-A]");

    // Switch to Fleet B
    await createAndSelectFleet(page, "Fleet-C4B");
    const fleetBId = await getSelectedFleetId(page);
    await injectCommanderMessage(page, "flagship", fleetBId, "[C4-FLAG-B] Fleet B msg");
    await assertMessageVisible(page, "[C4-FLAG-B]");

    await page.waitForTimeout(1000);

    // Return to Fleet A
    await selectFleet(page, "Fleet-C4A");
    await page.waitForTimeout(1000);

    // Inject fresh message to verify correct routing
    const fleetAIdAgain = await getSelectedFleetId(page);
    await injectCommanderMessage(page, "flagship", fleetAIdAgain, "[C4-FLAG-A2] Fleet A after return");

    await assertFlagshipActive(page);
    await assertMessageVisible(page, "[C4-FLAG-A2]");
    await assertMessageNotVisible(page, "[C4-FLAG-B]");
  });
});

// ===========================================================================
// D. Navigation During Sortie
// ===========================================================================

test.describe("D. Navigation During Sortie — Issue #681", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    await installWsCapture(page);
  });

  // D1: Sortie in progress on Fleet A → switch to Fleet B
  test("D1: Fleet A sortie in progress → Fleet B — no sortie stream contamination", async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.goto("/");
    await waitForConnection(page);

    await createAndSelectFleet(page, "Fleet-D1A");
    const fleetAId = await getSelectedFleetId(page);

    // Start a Ship sortie on Fleet A using direct data format
    const shipId = "e2e-d1-ship-001";
    await injectWsMessage(page, {
      type: "ship:created",
      data: {
        id: shipId,
        fleetId: fleetAId,
        repo: "mizunowanko-org/toy-admiral-test",
        issueNumber: 681,
        issueTitle: "D1 test ship",
        phase: "planning",
        branchName: "feature/681-d1-test",
      },
    });

    await page.waitForTimeout(1000);

    // Inject Flagship message after sortie starts
    await injectCommanderMessage(page, "flagship", fleetAId, "[D1-FLAG-A] Fleet A Flagship");
    await assertMessageVisible(page, "[D1-FLAG-A]");

    await page.waitForTimeout(1000);

    // Switch to Fleet B
    await createAndSelectFleet(page, "Fleet-D1B");
    const fleetBId = await getSelectedFleetId(page);
    await injectCommanderMessage(page, "flagship", fleetBId, "[D1-FLAG-B] Fleet B Flagship");

    await page.waitForTimeout(1000);

    // Fleet B should show only its messages
    await assertFlagshipActive(page);
    await assertMessageVisible(page, "[D1-FLAG-B]");
    await assertMessageNotVisible(page, "[D1-FLAG-A]");

    // Simulate continued sortie stream from Fleet A (should not appear in Fleet B)
    await injectWsMessage(page, {
      type: "ship:stream",
      data: {
        id: shipId,
        message: {
          type: "assistant",
          content: "[D1-SHIP-A-LATE] Fleet A Ship late stream",
          timestamp: Date.now(),
        },
      },
    });

    await page.waitForTimeout(1000);

    // Late Ship stream from Fleet A should NOT appear in Fleet B Flagship
    await assertMessageNotVisible(page, "[D1-SHIP-A-LATE]");
    await assertMessageVisible(page, "[D1-FLAG-B]");
  });

  // D2: Sortie just completed → Dock → Flagship switch
  test("D2: Fleet A sortie just completed → Dock → Flagship — correct chat displayed", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForConnection(page);

    await createAndSelectFleet(page, "Fleet-D2");
    const fleetId = await getSelectedFleetId(page);

    // Inject Flagship message (Flagship is default)
    await injectCommanderMessage(page, "flagship", fleetId, "[D2-FLAG] Flagship msg");
    await assertMessageVisible(page, "[D2-FLAG]");

    // Start and complete a Ship using direct data format
    const shipId = "e2e-d2-ship-001";
    await injectWsMessage(page, {
      type: "ship:created",
      data: {
        id: shipId,
        fleetId: fleetId,
        repo: "mizunowanko-org/toy-admiral-test",
        issueNumber: 681,
        issueTitle: "D2 test ship",
        phase: "planning",
        branchName: "feature/681-d2-test",
      },
    });

    await page.waitForTimeout(500);

    // Ship completes
    await injectWsMessage(page, {
      type: "ship:done",
      data: { id: shipId, fleetId, phase: "done" },
    });

    await page.waitForTimeout(1000);

    // Switch to Dock immediately after sortie completion
    await switchToDock(page);
    await injectCommanderMessage(page, "dock", fleetId, "[D2-DOCK] Dock msg after sortie");

    await page.waitForTimeout(1000);

    await assertDockActive(page);
    await assertMessageVisible(page, "[D2-DOCK]");
    await assertMessageNotVisible(page, "[D2-FLAG]");

    // Switch to Flagship
    await switchToFlagship(page);
    // Flagship message should still be there (same Fleet, just re-focused)
    await injectCommanderMessage(page, "flagship", fleetId, "[D2-FLAG2] Flagship after Dock");

    await page.waitForTimeout(1000);

    await assertFlagshipActive(page);
    await assertMessageVisible(page, "[D2-FLAG2]");
    await assertMessageNotVisible(page, "[D2-DOCK]");
  });
});
