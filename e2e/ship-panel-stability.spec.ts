/**
 * Ship Panel Display Stability E2E Test — Issue #820
 *
 * Validates that Ship cards are displayed stably in the Ships panel:
 * - Ship cards persist (not just flash briefly)
 * - Phase transitions don't remove ship cards
 * - Multiple ships display simultaneously
 * - Fleet switching preserves ship cards
 *
 * These tests address the reported instability where Ship cards would
 * appear briefly then disappear.
 */

import {
  test,
  expect,
  waitForConnection,
  createAndSelectFleet,
  createFleet,
} from "./fixtures";
import {
  installWsCapture,
  installShipSeedRoute,
  seedShip,
  updateSeededShip,
  completeSeededShip,
  getSelectedFleetId,
} from "./helpers/ws-helpers";

const SHIP_1 = {
  id: "e2e-panel-ship-001",
  repo: "test-org/test-repo",
  issueNumber: 701,
  issueTitle: "Panel stability test ship 1",
  branchName: "feature/701-panel-test-1",
};

const SHIP_2 = {
  id: "e2e-panel-ship-002",
  repo: "test-org/test-repo",
  issueNumber: 702,
  issueTitle: "Panel stability test ship 2",
  branchName: "feature/702-panel-test-2",
};

test.describe("Ship Panel Display Stability — Issue #820", () => {
  test.beforeEach(async ({ page }) => {
    await installWsCapture(page);
    await installShipSeedRoute(page);
  });

  test("Ship card persists continuously after sortie (not just a flash)", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Panel Stability Fleet");

    const fleetId = await getSelectedFleetId(page);

    // Seed a ship
    await seedShip(page, {
      ...SHIP_1,
      fleetId,
      phase: "plan",
    });

    // Wait for ship to appear
    const shipLocator = page.getByText(`#${SHIP_1.issueNumber}`).first();
    await expect(shipLocator).toBeVisible({ timeout: 10_000 });

    // Verify ship STAYS visible over 3 seconds (not just a flash)
    for (let i = 0; i < 3; i++) {
      await page.waitForTimeout(1000);
      await expect(shipLocator).toBeVisible();
    }
  });

  test("Ship card survives phase transitions", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Phase Survive Fleet");

    const fleetId = await getSelectedFleetId(page);

    await seedShip(page, {
      ...SHIP_1,
      fleetId,
      phase: "plan",
    });

    const shipLocator = page.getByText(`#${SHIP_1.issueNumber}`).first();
    await expect(shipLocator).toBeVisible({ timeout: 10_000 });

    // Walk through phase transitions and verify card stays visible
    const phases = ["plan-gate", "coding", "coding-gate", "merging"] as const;
    for (const phase of phases) {
      await updateSeededShip(page, SHIP_1.id, { phase });
      await expect(shipLocator).toBeVisible({ timeout: 3_000 });
    }
  });

  test("Multiple ships display simultaneously", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Multi Ship Fleet");

    const fleetId = await getSelectedFleetId(page);

    // Seed two ships
    await seedShip(page, { ...SHIP_1, fleetId, phase: "coding" });
    await seedShip(page, { ...SHIP_2, fleetId, phase: "plan" });

    // Both should be visible
    await expect(
      page.getByText(`#${SHIP_1.issueNumber}`).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(`#${SHIP_2.issueNumber}`).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Verify ship count shows 2
    await expect(page.getByText("2 ships")).toBeVisible({ timeout: 3_000 });
  });

  test("Ship card reappears when returning to fleet after switching away", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);

    // Create two fleets
    await createAndSelectFleet(page, "Fleet With Ship");
    const fleetIdA = await getSelectedFleetId(page);

    await createFleet(page, "Fleet Without Ship");

    // Select Fleet A and seed a ship
    await page.locator("button").filter({ hasText: "Fleet With Ship" }).click();
    await page.waitForTimeout(500);

    await seedShip(page, {
      ...SHIP_1,
      fleetId: fleetIdA,
      phase: "coding",
    });

    await expect(
      page.getByText(`#${SHIP_1.issueNumber}`).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Switch to Fleet B
    await page.locator("button").filter({ hasText: "Fleet Without Ship" }).click();
    await page.waitForTimeout(1000);

    // Switch back to Fleet A — ship should reappear
    await page.locator("button").filter({ hasText: "Fleet With Ship" }).click();
    await page.waitForTimeout(1000);

    // Ship should still be visible (re-fetched from Engine route)
    await expect(
      page.getByText(`#${SHIP_1.issueNumber}`).first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});
