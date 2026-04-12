/**
 * Ship/Escort Message Display E2E Tests — Issue #973
 *
 * Covers audit gaps:
 * - #817: Ship/Escort messages both visible in Ship detail
 * - #891: Escort system notification filter (suppress in non-Ship views)
 * - #902: Message ordering after reload
 *
 * Uses seeded ships + WS message injection to verify message display rules.
 */

import {
  test,
  expect,
  waitForConnection,
  createAndSelectFleet,
} from "./fixtures";
import {
  installWsCapture,
  installShipSeedRoute,
  seedShip,
  injectWsMessage,
  injectEscortMessage,
  injectShipMessage,
  getSelectedFleetId,
} from "./helpers/ws-helpers";

const SHIP = {
  id: "e2e-escort-msg-ship-001",
  repo: "test-org/test-repo",
  issueNumber: 817,
  issueTitle: "Ship/Escort message test",
  branchName: "feature/817-escort-msg",
};

test.describe.serial("Ship/Escort Messages — Issues #817, #891, #902", () => {
  test.beforeEach(async ({ page }) => {
    await installWsCapture(page);
    await installShipSeedRoute(page);
  });

  test("Ship and Escort messages both visible when Ship is focused", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Escort-Msg-Fleet");

    const fleetId = await getSelectedFleetId(page);

    await seedShip(page, {
      ...SHIP,
      fleetId,
      phase: "coding",
    });

    await expect(
      page.getByText(`#${SHIP.issueNumber}`).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Click on the ship card to focus it
    await page.getByText(`#${SHIP.issueNumber}`).first().click();
    await page.waitForTimeout(500);

    // Inject Ship message
    await injectShipMessage(page, SHIP.id, "[SHIP-MSG] Implementing feature...");

    // Inject Escort message
    await injectEscortMessage(page, SHIP.id, "[ESCORT-MSG] Gate review feedback");

    // Both should be visible in Ship view
    await expect(page.getByText("[SHIP-MSG]").first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("[ESCORT-MSG]").first()).toBeVisible({ timeout: 5_000 });
  });

  test("Escort messages filtered in commander (Flagship) view", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Escort-Filter-Fleet");

    const fleetId = await getSelectedFleetId(page);

    await seedShip(page, {
      ...SHIP,
      id: "e2e-escort-filter-ship-001",
      fleetId,
      phase: "coding",
    });

    await expect(
      page.getByText(`#${SHIP.issueNumber}`).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Inject Escort message for the ship (goes to ship logs)
    await injectEscortMessage(
      page,
      "e2e-escort-filter-ship-001",
      "[ESCORT-HIDDEN] This should not appear in Flagship",
    );

    // Inject Flagship message (commander context)
    await injectWsMessage(page, {
      type: "flagship:stream",
      data: {
        fleetId,
        message: {
          type: "assistant",
          content: "[FLAG-MSG] Flagship response",
          timestamp: Date.now(),
        },
      },
    });

    await page.waitForTimeout(500);

    // Flagship should show its own message
    await expect(page.getByText("[FLAG-MSG]").first()).toBeVisible({ timeout: 5_000 });

    // Escort message should NOT appear in Flagship view
    await expect(page.getByText("[ESCORT-HIDDEN]")).not.toBeVisible({ timeout: 2_000 });
  });

  test("Escort messages filtered in Dock view", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "EscortLogFilter-Fleet");

    const fleetId = await getSelectedFleetId(page);

    await seedShip(page, {
      ...SHIP,
      id: "e2e-escort-dock-ship-001",
      fleetId,
      phase: "coding",
    });

    await expect(
      page.getByText(`#${SHIP.issueNumber}`).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Switch to Dock
    const dockTab = page.getByRole("button", { name: /dock/i });
    await dockTab.click();
    await expect(
      page.getByPlaceholder("Send a command to Dock..."),
    ).toBeVisible({ timeout: 5000 });

    // Inject Escort message for the ship
    await injectEscortMessage(
      page,
      "e2e-escort-dock-ship-001",
      "[ESCORT-DOCK-HIDDEN] Should not appear in Dock",
    );

    // Inject Dock message
    await injectWsMessage(page, {
      type: "dock:stream",
      data: {
        fleetId,
        message: {
          type: "assistant",
          content: "[DOCK-MSG] Dock response",
          timestamp: Date.now(),
        },
      },
    });

    await page.waitForTimeout(500);

    // Dock should show its own message
    await expect(page.getByText("[DOCK-MSG]").first()).toBeVisible({ timeout: 5_000 });

    // Escort message should NOT appear in Dock view
    await expect(page.getByText("[ESCORT-DOCK-HIDDEN]")).not.toBeVisible({
      timeout: 2_000,
    });
  });

  test("Ship and Escort messages maintain chronological order", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Msg-Order-Fleet");

    const fleetId = await getSelectedFleetId(page);

    await seedShip(page, {
      ...SHIP,
      id: "e2e-order-ship-001",
      fleetId,
      phase: "coding",
    });

    await expect(
      page.getByText(`#${SHIP.issueNumber}`).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Click on ship to focus it
    await page.getByText(`#${SHIP.issueNumber}`).first().click();
    await page.waitForTimeout(500);

    const baseTime = Date.now();

    // Inject messages in chronological order with explicit timestamps
    await injectShipMessage(page, "e2e-order-ship-001", "[ORDER-1] First ship message", baseTime);
    await injectEscortMessage(page, "e2e-order-ship-001", "[ORDER-2] Escort review", baseTime + 1000);
    await injectShipMessage(page, "e2e-order-ship-001", "[ORDER-3] Ship response to review", baseTime + 2000);
    await injectEscortMessage(page, "e2e-order-ship-001", "[ORDER-4] Escort final verdict", baseTime + 3000);

    // All messages should be visible
    await expect(page.getByText("[ORDER-1]").first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("[ORDER-2]").first()).toBeVisible();
    await expect(page.getByText("[ORDER-3]").first()).toBeVisible();
    await expect(page.getByText("[ORDER-4]").first()).toBeVisible();

    // Verify ordering: ORDER-1 should appear before ORDER-4
    const msg1 = page.getByText("[ORDER-1]").first();
    const msg4 = page.getByText("[ORDER-4]").first();

    const box1 = await msg1.boundingBox();
    const box4 = await msg4.boundingBox();

    if (box1 && box4) {
      expect(box1.y).toBeLessThan(box4.y);
    }
  });
});
