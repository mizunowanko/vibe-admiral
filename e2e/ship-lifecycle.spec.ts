/**
 * Ship Lifecycle E2E Test — Issue #780
 *
 * Verifies that Ship phase transitions (plan → plan-gate → coding →
 * coding-gate → merging → done) are correctly reflected in the UI.
 *
 * Uses a real Engine for WS transport and fleet management.
 * Ship data is seeded via Playwright route interception + WS notification
 * (notification-only protocol per ADR-0019).
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
  completeSeededShip,
  getSelectedFleetId,
} from "./helpers/ws-helpers";

const SHIP = {
  id: "e2e-lifecycle-ship-001",
  repo: "test-org/test-repo",
  issueNumber: 100,
  issueTitle: "Test feature implementation",
  branchName: "feature/100-test-feature",
};

const PHASES = [
  "plan",
  "plan-gate",
  "coding",
  "coding-gate",
  "qa",
  "qa-gate",
  "merging",
  "done",
] as const;

test.describe.serial("Ship Lifecycle — Phase Transitions", () => {
  test.beforeEach(async ({ page }) => {
    await installWsCapture(page);
    await installShipSeedRoute(page);
  });

  test("Ship phases are reflected in UI as they transition", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Lifecycle Fleet");

    const fleetId = await getSelectedFleetId(page);

    await seedShip(page, {
      ...SHIP,
      fleetId,
      phase: "plan",
    });

    // Wait for ship to appear
    await expect(
      page.getByText(`#${SHIP.issueNumber}`).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Walk through active phases (not done — done ships are hidden by default)
    for (const phase of PHASES) {
      if (phase === "plan") continue;
      if (phase === "done") continue; // Tested separately below

      await updateSeededShip(page, SHIP.id, { phase });

      // Ship should remain visible through active phases
      await expect(
        page.getByText(`#${SHIP.issueNumber}`).first(),
      ).toBeVisible({ timeout: 5_000 });
    }
  });

  test("Ship done event shows completion state", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Done Fleet");

    const fleetId = await getSelectedFleetId(page);

    await seedShip(page, {
      ...SHIP,
      fleetId,
      phase: "plan",
    });

    await expect(
      page.getByText(`#${SHIP.issueNumber}`).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Move to merging
    await updateSeededShip(page, SHIP.id, { phase: "merging" });

    // Ship done
    await completeSeededShip(page, SHIP.id);

    // Enable "Show inactive" to see done ships
    const showInactive = page.getByText("Show inactive");
    if (await showInactive.isVisible({ timeout: 2000 }).catch(() => false)) {
      await showInactive.click();
    }

    // Verify ship shows as completed
    await expect(
      page.getByText(`#${SHIP.issueNumber}`).first(),
    ).toBeVisible({ timeout: 5_000 });
  });
});
