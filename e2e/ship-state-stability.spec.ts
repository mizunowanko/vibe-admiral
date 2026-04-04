import {
  test,
  expect,
  waitForConnection,
  createAndSelectFleet,
} from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * Ship State Stability E2E Test — Issue #572
 *
 * Investigates whether the UI state resets when a Ship is added or completed.
 * Uses a real Engine and injects WebSocket messages (ship:created, ship:status,
 * ship:done) into the app's live WebSocket connection to simulate Ship lifecycle
 * events without requiring Claude CLI execution.
 *
 * Approach:
 *   page.addInitScript wraps the native WebSocket constructor to capture
 *   the app's connection instance. Messages are then dispatched via
 *   MessageEvent on that instance, indistinguishable from real Engine sends.
 *
 * Instrumentation:
 *   - MutationObserver for DOM re-mount / layout shift detection
 *   - Periodic textarea presence check (component mount tracking)
 *
 * If PR #570 fixed the issue, these tests pass as regression guards.
 * If the issue persists, instrumentation logs reveal the root cause.
 */

/** Unique IDs for simulated ships */
const SHIP_A = {
  id: "e2e-ship-aaa-1111",
  repo: "mizunowanko-org/toy-admiral-test",
  issueNumber: 999,
  issueTitle: "E2E test ship A",
  branchName: "feature/999-e2e-test-ship-a",
};

const SHIP_B = {
  id: "e2e-ship-bbb-2222",
  repo: "mizunowanko-org/toy-admiral-test",
  issueNumber: 998,
  issueTitle: "E2E test ship B",
  branchName: "feature/998-e2e-test-ship-b",
};

// ---------------------------------------------------------------------------
// WebSocket capture — run before page scripts load
// ---------------------------------------------------------------------------

/**
 * Install a WebSocket wrapper via addInitScript so we can capture the app's
 * WebSocket instance before any application code runs.
 */
async function installWsCapture(page: Page) {
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
    // Preserve prototype chain for instanceof checks
    window.WebSocket.prototype = OriginalWebSocket.prototype;
    Object.defineProperty(window.WebSocket, "CONNECTING", { value: 0 });
    Object.defineProperty(window.WebSocket, "OPEN", { value: 1 });
    Object.defineProperty(window.WebSocket, "CLOSING", { value: 2 });
    Object.defineProperty(window.WebSocket, "CLOSED", { value: 3 });
  });
}

// ---------------------------------------------------------------------------
// WebSocket message injection
// ---------------------------------------------------------------------------

/**
 * Dispatch a ServerMessage on the app's captured WebSocket instance.
 * This triggers the same `onmessage` handler that the ws-client uses.
 */
async function injectWsMessage(page: Page, message: Record<string, unknown>) {
  await page.evaluate((msg) => {
    const captured = (window as unknown as Record<string, WebSocket[]>).__capturedWs;
    // Use the first open WebSocket (the app's ws-client connection)
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
// Instrumentation helpers
// ---------------------------------------------------------------------------

interface InstrumentationData {
  domMutations: Array<{
    timestamp: number;
    type: string;
    addedNodes: number;
    removedNodes: number;
    targetTag: string;
    targetTestId: string | null;
  }>;
  chatMountHistory: Array<{ timestamp: number; mounted: boolean }>;
}

async function injectInstrumentation(page: Page) {
  await page.evaluate(() => {
    const inst = {
      domMutations: [] as InstrumentationData["domMutations"],
      chatMountHistory: [] as InstrumentationData["chatMountHistory"],
    };
    (window as unknown as Record<string, unknown>).__e2eInst = inst;

    // MutationObserver on the closest wrapper we can find
    const root =
      document.querySelector("[data-testid='main-panel']") ??
      document.querySelector("main") ??
      document.body;

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (
          m.type === "childList" &&
          (m.addedNodes.length > 0 || m.removedNodes.length > 0)
        ) {
          const t = m.target as HTMLElement;
          inst.domMutations.push({
            timestamp: Date.now(),
            type: m.type,
            addedNodes: m.addedNodes.length,
            removedNodes: m.removedNodes.length,
            targetTag: t.tagName ?? "unknown",
            targetTestId: t.getAttribute?.("data-testid") ?? null,
          });
        }
      }
    });
    observer.observe(root, { childList: true, subtree: true });

    // Periodic textarea presence check
    let prevMounted = true;
    const interval = setInterval(() => {
      const mounted = !!(
        document.querySelector("textarea[placeholder*='Flagship']") ??
        document.querySelector("textarea[placeholder*='command']")
      );
      if (mounted !== prevMounted) {
        inst.chatMountHistory.push({ timestamp: Date.now(), mounted });
        prevMounted = mounted;
      }
    }, 50);
    (window as unknown as Record<string, unknown>).__e2eInterval = interval;
  });
}

async function getInstrumentation(page: Page): Promise<InstrumentationData> {
  return page.evaluate(
    () =>
      (window as unknown as Record<string, InstrumentationData>).__e2eInst ?? {
        domMutations: [],
        chatMountHistory: [],
      },
  );
}

function logReport(label: string, data: InstrumentationData) {
  console.log(`\n=== ${label} ===`);
  console.log(`DOM mutations: ${data.domMutations.length}`);
  for (const m of data.domMutations.slice(0, 20)) {
    console.log(
      `  [${new Date(m.timestamp).toISOString()}] +${m.addedNodes}/-${m.removedNodes} on <${m.targetTag}> (testId: ${m.targetTestId ?? "none"})`,
    );
  }
  if (data.domMutations.length > 20) {
    console.log(`  ... and ${data.domMutations.length - 20} more`);
  }
  if (data.chatMountHistory.length > 0) {
    console.log("Chat mount state changes (should be empty if stable):");
    for (const h of data.chatMountHistory) {
      console.log(
        `  [${new Date(h.timestamp).toISOString()}] mounted=${h.mounted}`,
      );
    }
  } else {
    console.log("Chat mount state: stable (no unmount detected)");
  }
  console.log(`=== End ${label} ===\n`);
}

// ---------------------------------------------------------------------------
// Shared assertion helpers
// ---------------------------------------------------------------------------

async function assertUIPreserved(
  page: Page,
  fleetName: string,
  expectedText: string,
  markerValue: string,
) {
  // Fleet selection maintained
  const fleetButton = page.locator("button").filter({ hasText: fleetName });
  await expect(fleetButton).toBeVisible({ timeout: 3000 });

  // Flagship chat still visible
  const input = page.getByPlaceholder("Send a command to Flagship...");
  await expect(input).toBeVisible({ timeout: 3000 });

  // Input text preserved
  await expect(input).toHaveValue(expectedText, { timeout: 3000 });

  // Chat container not remounted (data-e2e-marker still present)
  const markerPresent = await page.evaluate(
    (v) =>
      !!document.querySelector(`textarea[data-e2e-marker='${v}']`),
    markerValue,
  );
  expect(markerPresent).toBe(true);
}

/**
 * Place a marker attribute on the textarea so we can later verify the same
 * DOM element is still present (not unmounted and recreated).
 */
async function markTextarea(page: Page, markerValue: string) {
  await page.evaluate((v) => {
    const el =
      document.querySelector("textarea[placeholder*='Flagship']") ??
      document.querySelector("textarea");
    if (el) (el as HTMLElement).setAttribute("data-e2e-marker", v);
  }, markerValue);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Ship State Stability — Issue #572", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    await installWsCapture(page);
  });

  test("Pattern A: UI state preserved when Ship is added", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForConnection(page);
    await createAndSelectFleet(page, "Ship Stability Test");

    // Retrieve the fleet ID that the Engine assigned
    const fleetId = await page.evaluate(() => {
      // The sidebar button's closest data attribute, or fallback
      const btn = document.querySelector("button.bg-accent");
      return btn?.getAttribute("data-fleet-id") ?? "";
    });

    const flagshipInput = page.getByPlaceholder(
      "Send a command to Flagship...",
    );
    await expect(flagshipInput).toBeVisible({ timeout: 5000 });

    // Type text — do NOT submit
    const testText = "test input preservation for ship addition";
    await flagshipInput.fill(testText);
    await expect(flagshipInput).toHaveValue(testText);

    // Install instrumentation + marker
    await injectInstrumentation(page);
    await markTextarea(page, "ship-add");

    // ── Simulate Ship addition ──
    await injectWsMessage(page, {
      type: "ship:created",
      data: {
        id: SHIP_A.id,
        fleetId: fleetId || "unknown-fleet",
        repo: SHIP_A.repo,
        issueNumber: SHIP_A.issueNumber,
        issueTitle: SHIP_A.issueTitle,
        phase: "planning",
        branchName: SHIP_A.branchName,
      },
    });

    // Follow with a ship:status update (Engine sends both in quick succession)
    await page.waitForTimeout(200);
    await injectWsMessage(page, {
      type: "ship:status",
      data: {
        id: SHIP_A.id,
        phase: "planning",
        fleetId: fleetId || "unknown-fleet",
        repo: SHIP_A.repo,
        issueNumber: SHIP_A.issueNumber,
        issueTitle: SHIP_A.issueTitle,
      },
    });

    await page.waitForTimeout(500);

    // ── Assertions ──
    await assertUIPreserved(
      page,
      "Ship Stability Test",
      testText,
      "ship-add",
    );

    const inst = await getInstrumentation(page);
    logReport("Ship Addition", inst);

    // Additional: verify the chat textarea was never temporarily unmounted
    expect(inst.chatMountHistory.length).toBe(0);
  });

  test("Pattern B: UI state preserved when Ship completes", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForConnection(page);
    await createAndSelectFleet(page, "Ship Done Test");

    const fleetId = await page.evaluate(() => {
      const btn = document.querySelector("button.bg-accent");
      return btn?.getAttribute("data-fleet-id") ?? "";
    });

    const flagshipInput = page.getByPlaceholder(
      "Send a command to Flagship...",
    );
    await expect(flagshipInput).toBeVisible({ timeout: 5000 });

    // First add a ship so there's something to complete
    await injectWsMessage(page, {
      type: "ship:created",
      data: {
        id: SHIP_B.id,
        fleetId: fleetId || "unknown-fleet",
        repo: SHIP_B.repo,
        issueNumber: SHIP_B.issueNumber,
        issueTitle: SHIP_B.issueTitle,
        phase: "implementing",
        branchName: SHIP_B.branchName,
      },
    });
    await page.waitForTimeout(300);

    // Type text
    const testText = "test input preservation for ship completion";
    await flagshipInput.fill(testText);
    await expect(flagshipInput).toHaveValue(testText);

    await injectInstrumentation(page);
    await markTextarea(page, "ship-done");

    // ── Simulate Ship completion ──
    await injectWsMessage(page, {
      type: "ship:done",
      data: {
        id: SHIP_B.id,
        prUrl: "https://github.com/mizunowanko-org/toy-admiral-test/pull/42",
        merged: true,
      },
    });

    await page.waitForTimeout(500);

    await assertUIPreserved(page, "Ship Done Test", testText, "ship-done");

    const inst = await getInstrumentation(page);
    logReport("Ship Completion", inst);
    expect(inst.chatMountHistory.length).toBe(0);
  });

  test("Pattern C: UI state preserved under rapid ship status updates", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForConnection(page);
    await createAndSelectFleet(page, "Rapid Update Test");

    const fleetId = await page.evaluate(() => {
      const btn = document.querySelector("button.bg-accent");
      return btn?.getAttribute("data-fleet-id") ?? "";
    });

    const flagshipInput = page.getByPlaceholder(
      "Send a command to Flagship...",
    );
    await expect(flagshipInput).toBeVisible({ timeout: 5000 });

    const testText = "test input preservation for rapid updates";
    await flagshipInput.fill(testText);
    await expect(flagshipInput).toHaveValue(testText);

    await injectInstrumentation(page);
    await markTextarea(page, "rapid");

    const shipId = "e2e-ship-rapid-001";
    const commonData = {
      fleetId: fleetId || "unknown-fleet",
      repo: "mizunowanko-org/toy-admiral-test",
      issueNumber: 997,
      issueTitle: "Rapid phase test",
    };

    // Create ship
    await injectWsMessage(page, {
      type: "ship:created",
      data: {
        id: shipId,
        ...commonData,
        phase: "planning",
        branchName: "feature/997-rapid-test",
      },
    });

    // Rapid phase transitions (50ms apart)
    const phases = [
      "planning",
      "planning-gate",
      "implementing",
      "implementing-gate",
      "qa",
      "qa-gate",
      "merging",
    ] as const;

    for (const phase of phases) {
      await page.waitForTimeout(50);
      await injectWsMessage(page, {
        type: "ship:status",
        data: { id: shipId, phase, ...commonData },
      });
    }

    // Complete
    await page.waitForTimeout(50);
    await injectWsMessage(page, {
      type: "ship:done",
      data: {
        id: shipId,
        prUrl: "https://github.com/mizunowanko-org/toy-admiral-test/pull/43",
        merged: true,
      },
    });

    await page.waitForTimeout(500);

    await assertUIPreserved(page, "Rapid Update Test", testText, "rapid");

    const inst = await getInstrumentation(page);
    logReport("Rapid Ship Updates", inst);
    expect(inst.chatMountHistory.length).toBe(0);
  });
});
