import {
  test,
  expect,
  waitForConnection,
  createAndSelectFleet,
  createFleet,
} from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * Chat Preservation E2E Tests — Issue #657
 *
 * Validates that the Dock chat input is preserved during various Ship lifecycle
 * events. Specifically targets the screen-refresh bug (#656) where Sortie caused
 * the UI to jump to the Flagship session, destroying the user's draft input.
 *
 * Uses WebSocket message injection to simulate Engine events without requiring
 * actual Claude CLI execution. Includes intentional delays (1s) between operations
 * to widen the race-condition window per the issue comment guidance.
 */

// ---------------------------------------------------------------------------
// Simulated ship data
// ---------------------------------------------------------------------------

const SHIP_1 = {
  id: "e2e-chat-ship-001",
  repo: "mizunowanko-org/toy-admiral-test",
  issueNumber: 901,
  issueTitle: "Chat preservation test ship 1",
  branchName: "feature/901-chat-test-1",
};

const SHIP_2 = {
  id: "e2e-chat-ship-002",
  repo: "mizunowanko-org/toy-admiral-test",
  issueNumber: 902,
  issueTitle: "Chat preservation test ship 2",
  branchName: "feature/902-chat-test-2",
};

// ---------------------------------------------------------------------------
// WebSocket capture — identical to ship-state-stability.spec.ts
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

/** Switch to the Flagship tab and return the Flagship input locator. */
async function switchToFlagship(page: Page) {
  const flagshipTab = page.getByRole("button", { name: /flagship/i });
  await expect(flagshipTab).toBeVisible({ timeout: 5000 });
  await flagshipTab.click();

  const flagshipInput = page.getByPlaceholder(
    "Send a command to Flagship...",
  );
  await expect(flagshipInput).toBeVisible({ timeout: 5000 });
  return flagshipInput;
}

/**
 * Place a marker attribute on the current chat textarea so we can verify
 * the same DOM element persists (not unmounted and recreated).
 */
async function markChatTextarea(page: Page, markerValue: string) {
  await page.evaluate((v) => {
    const el =
      document.querySelector("textarea[placeholder*='Dock']") ??
      document.querySelector("textarea[placeholder*='Flagship']") ??
      document.querySelector("textarea");
    if (el) (el as HTMLElement).setAttribute("data-e2e-marker", v);
  }, markerValue);
}

/** Check that the marker attribute is still present on the same DOM node. */
async function hasMarker(page: Page, markerValue: string): Promise<boolean> {
  return page.evaluate(
    (v) => !!document.querySelector(`textarea[data-e2e-marker='${v}']`),
    markerValue,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Chat Preservation — Issue #657 (#656 regression)", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    await installWsCapture(page);
  });

  // ── Scenario 1: Sortie 時のチャット維持 ──
  test("Scenario 1: Dock chat input preserved when Ship is sortied", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForConnection(page);
    await createAndSelectFleet(page, "Sortie Chat Test");

    const fleetId = await getSelectedFleetId(page);

    // Switch to Dock and fill text
    const dockInput = await switchToDock(page);
    const testText = "アタシのテスト入力だよ！消えるなよ！";
    await dockInput.fill(testText);
    await expect(dockInput).toHaveValue(testText);

    // Mark the textarea DOM node
    await markChatTextarea(page, "sortie-1");

    // ── Simulate Sortie (ship:created from Engine) ──
    await injectWsMessage(page, {
      type: "ship:created",
      data: {
        id: SHIP_1.id,
        fleetId: fleetId || "unknown-fleet",
        repo: SHIP_1.repo,
        issueNumber: SHIP_1.issueNumber,
        issueTitle: SHIP_1.issueTitle,
        phase: "planning",
        branchName: SHIP_1.branchName,
      },
    });

    // Wait 1s to catch race conditions (per issue comment guidance)
    await page.waitForTimeout(1000);

    // Follow with ship:status (Engine sends both in quick succession)
    await injectWsMessage(page, {
      type: "ship:status",
      data: {
        id: SHIP_1.id,
        phase: "planning",
        fleetId: fleetId || "unknown-fleet",
        repo: SHIP_1.repo,
        issueNumber: SHIP_1.issueNumber,
        issueTitle: SHIP_1.issueTitle,
      },
    });

    await page.waitForTimeout(1000);

    // ── Assertions ──
    // Chat should NOT have jumped to Flagship
    await expect(dockInput).toBeVisible({ timeout: 3000 });
    // Input text preserved
    await expect(dockInput).toHaveValue(testText, { timeout: 3000 });
    // Same DOM node (not remounted)
    expect(await hasMarker(page, "sortie-1")).toBe(true);
  });

  // ── Scenario 2: Phase 遷移時のチャット維持 ──
  test("Scenario 2: Dock chat input preserved during phase transitions", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForConnection(page);
    await createAndSelectFleet(page, "Phase Transit Test");

    const fleetId = await getSelectedFleetId(page);

    // Create a ship first
    await injectWsMessage(page, {
      type: "ship:created",
      data: {
        id: SHIP_1.id,
        fleetId: fleetId || "unknown-fleet",
        repo: SHIP_1.repo,
        issueNumber: SHIP_1.issueNumber,
        issueTitle: SHIP_1.issueTitle,
        phase: "planning",
        branchName: SHIP_1.branchName,
      },
    });
    await page.waitForTimeout(500);

    // Switch to Dock and fill text
    const dockInput = await switchToDock(page);
    const testText = "Phase遷移中もアタシの入力は消えないはず！";
    await dockInput.fill(testText);
    await expect(dockInput).toHaveValue(testText);

    await markChatTextarea(page, "phase-transit");

    // ── Simulate phase transitions: plan → coding → QA ──
    const phases = [
      "planning",
      "plan-gate",
      "coding",
      "coding-gate",
      "qa",
    ] as const;

    const commonData = {
      id: SHIP_1.id,
      fleetId: fleetId || "unknown-fleet",
      repo: SHIP_1.repo,
      issueNumber: SHIP_1.issueNumber,
      issueTitle: SHIP_1.issueTitle,
    };

    for (const phase of phases) {
      await injectWsMessage(page, {
        type: "ship:status",
        data: { ...commonData, phase },
      });

      // 1s wait between each transition to catch race conditions
      await page.waitForTimeout(1000);

      // Verify after EACH transition
      await expect(dockInput).toBeVisible({ timeout: 3000 });
      await expect(dockInput).toHaveValue(testText, { timeout: 3000 });
    }

    // Final check: DOM node still the same
    expect(await hasMarker(page, "phase-transit")).toBe(true);
  });

  // ── Scenario 3: 複数 Ship sortie ──
  test("Scenario 3: Dock chat input preserved on second Ship sortie", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForConnection(page);
    await createAndSelectFleet(page, "Multi Sortie Test");

    const fleetId = await getSelectedFleetId(page);

    // Switch to Dock and fill text
    const dockInput = await switchToDock(page);
    const testText = "2隻目が出ても大丈夫なはず！";
    await dockInput.fill(testText);
    await expect(dockInput).toHaveValue(testText);

    await markChatTextarea(page, "multi-sortie");

    // ── Sortie 1st Ship ──
    await injectWsMessage(page, {
      type: "ship:created",
      data: {
        id: SHIP_1.id,
        fleetId: fleetId || "unknown-fleet",
        repo: SHIP_1.repo,
        issueNumber: SHIP_1.issueNumber,
        issueTitle: SHIP_1.issueTitle,
        phase: "planning",
        branchName: SHIP_1.branchName,
      },
    });

    await page.waitForTimeout(1000);

    // Verify after 1st sortie
    await expect(dockInput).toBeVisible({ timeout: 3000 });
    await expect(dockInput).toHaveValue(testText, { timeout: 3000 });

    // ── Sortie 2nd Ship ──
    await injectWsMessage(page, {
      type: "ship:created",
      data: {
        id: SHIP_2.id,
        fleetId: fleetId || "unknown-fleet",
        repo: SHIP_2.repo,
        issueNumber: SHIP_2.issueNumber,
        issueTitle: SHIP_2.issueTitle,
        phase: "planning",
        branchName: SHIP_2.branchName,
      },
    });

    await page.waitForTimeout(1000);

    // ── Assertions ──
    await expect(dockInput).toBeVisible({ timeout: 3000 });
    await expect(dockInput).toHaveValue(testText, { timeout: 3000 });
    expect(await hasMarker(page, "multi-sortie")).toBe(true);
  });

  // ── Scenario 4: Fleet 切り替え往復 ──
  test("Scenario 4: Dock chat input restored after fleet round-trip", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForConnection(page);

    // Create Fleet A
    await createAndSelectFleet(page, "Fleet Alpha");

    // Switch to Dock on Fleet A and fill text
    const dockInputA = await switchToDock(page);
    const testTextA = "Fleet Aのアタシの入力！戻ったら復元されるはず！";
    await dockInputA.fill(testTextA);
    await expect(dockInputA).toHaveValue(testTextA);

    await page.waitForTimeout(1000);

    // Create and switch to Fleet B
    await createAndSelectFleet(page, "Fleet Bravo");

    // Verify we're on Fleet B (Flagship should be visible for new fleet)
    const flagshipInputB = page.getByPlaceholder(
      "Send a command to Flagship...",
    );
    await expect(flagshipInputB).toBeVisible({ timeout: 5000 });

    await page.waitForTimeout(1000);

    // Switch back to Fleet A
    const fleetAButton = page.locator("button").filter({ hasText: "Fleet Alpha" });
    await fleetAButton.click();

    await page.waitForTimeout(1000);

    // Switch back to Dock on Fleet A
    const dockInputRestored = await switchToDock(page);

    // ── Assertion: input text should be restored ──
    await expect(dockInputRestored).toHaveValue(testTextA, { timeout: 5000 });
  });
});
