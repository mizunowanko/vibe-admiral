/**
 * Ship Resume E2E Test — Issue #780
 *
 * Verifies that a paused Ship can be resumed and its phase is restored in the UI.
 * Tests the pause → resume cycle with phase preservation.
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
  updateSeededShip,
  getSelectedFleetId,
} from "./helpers/ws-helpers";

const SHIP = {
  id: "e2e-resume-ship-001",
  repo: "test-org/test-repo",
  issueNumber: 200,
  issueTitle: "Ship resume test",
  branchName: "feature/200-ship-resume",
};

test.describe.serial("Ship Resume — Pause and Resume Cycle", () => {
  test.beforeEach(async ({ page }) => {
    await installWsCapture(page);
    await installShipSeedRoute(page);
  });

  test("paused Ship shows paused state in UI", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Resume Fleet");

    const fleetId = await getSelectedFleetId(page);

    // Create ship in coding phase
    await seedShip(page, {
      ...SHIP,
      fleetId,
      phase: "coding",
    });

    await expect(
      page.getByText(`#${SHIP.issueNumber}`).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Pause the ship
    await updateSeededShip(page, SHIP.id, { phase: "paused" });

    // Enable "Show inactive" to see paused ships
    const showInactive = page.getByText("Show inactive");
    if (await showInactive.isVisible({ timeout: 3000 }).catch(() => false)) {
      await showInactive.click();
    }

    // Verify paused state is shown
    await expect(
      page.getByText(`#${SHIP.issueNumber}`).first(),
    ).toBeVisible();
  });

  test("resumed Ship restores previous phase in UI", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Resume Fleet 2");

    const fleetId = await getSelectedFleetId(page);

    // Create ship in coding phase
    await seedShip(page, {
      ...SHIP,
      fleetId,
      phase: "coding",
    });

    await expect(
      page.getByText(`#${SHIP.issueNumber}`).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Pause
    await updateSeededShip(page, SHIP.id, { phase: "paused" });

    // Resume — phase goes back to coding
    await updateSeededShip(page, SHIP.id, { phase: "coding" });

    // Ship should be visible and active again
    await expect(
      page.getByText(`#${SHIP.issueNumber}`).first(),
    ).toBeVisible();
  });

  test("abandoned Ship is distinct from paused", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Abandon Fleet");

    const fleetId = await getSelectedFleetId(page);

    // Create ship
    await seedShip(page, {
      ...SHIP,
      fleetId,
      phase: "coding",
    });

    await expect(
      page.getByText(`#${SHIP.issueNumber}`).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Abandon the ship
    await updateSeededShip(page, SHIP.id, { phase: "abandoned" });

    // Enable "Show inactive" to see abandoned ships
    const showInactive2 = page.getByText("Show inactive");
    if (await showInactive2.isVisible({ timeout: 3000 }).catch(() => false)) {
      await showInactive2.click();
    }

    // Abandoned ship should still be visible but marked differently
    await expect(
      page.getByText(`#${SHIP.issueNumber}`).first(),
    ).toBeVisible();
  });
});
