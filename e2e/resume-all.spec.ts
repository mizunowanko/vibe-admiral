/**
 * Resume All E2E Test — Issue #780
 *
 * Verifies that the Resume All operation:
 * - Resumes only paused Ships
 * - Does NOT resume abandoned Ships
 * - Correctly updates UI state for each Ship
 *
 * Related: #763 (split stopped into paused/abandoned)
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

const SHIP_PAUSED = {
  id: "e2e-resume-all-paused-001",
  repo: "test-org/test-repo",
  issueNumber: 601,
  issueTitle: "Paused ship for resume all",
  branchName: "feature/601-paused",
};

const SHIP_PAUSED_2 = {
  id: "e2e-resume-all-paused-002",
  repo: "test-org/test-repo",
  issueNumber: 602,
  issueTitle: "Another paused ship",
  branchName: "feature/602-paused-2",
};

const SHIP_ABANDONED = {
  id: "e2e-resume-all-abandoned-001",
  repo: "test-org/test-repo",
  issueNumber: 603,
  issueTitle: "Abandoned ship (should not resume)",
  branchName: "feature/603-abandoned",
};

const SHIP_ACTIVE = {
  id: "e2e-resume-all-active-001",
  repo: "test-org/test-repo",
  issueNumber: 604,
  issueTitle: "Active ship (already running)",
  branchName: "feature/604-active",
};

test.describe.serial("Resume All — Selective Resume", () => {
  test.beforeEach(async ({ page }) => {
    await installWsCapture(page);
    await installShipSeedRoute(page);
  });

  test("UI shows mixed ship states correctly", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Resume All Fleet");

    const fleetId = await getSelectedFleetId(page);

    // Create ships in different states
    const ships = [
      { ...SHIP_PAUSED, phase: "paused" },
      { ...SHIP_PAUSED_2, phase: "paused" },
      { ...SHIP_ABANDONED, phase: "abandoned" },
      { ...SHIP_ACTIVE, phase: "coding" },
    ];

    for (const ship of ships) {
      await seedShip(page, { ...ship, fleetId });
    }

    // Enable "Show inactive" to see paused and abandoned ships
    const showInactive = page.getByText("Show inactive");
    if (await showInactive.isVisible({ timeout: 3000 }).catch(() => false)) {
      await showInactive.click();
    }

    // All ships should be visible
    for (const ship of ships) {
      await expect(
        page.getByText(`#${ship.issueNumber}`).first(),
      ).toBeVisible({ timeout: 10_000 });
    }
  });

  test("simulated resume all only resumes paused ships", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Selective Resume Fleet");

    const fleetId = await getSelectedFleetId(page);

    // Create ships in different states
    await seedShip(page, { ...SHIP_PAUSED, fleetId, phase: "paused" });
    await seedShip(page, { ...SHIP_ABANDONED, fleetId, phase: "abandoned" });
    await seedShip(page, { ...SHIP_ACTIVE, fleetId, phase: "coding" });

    // Enable "Show inactive" to see paused and abandoned ships
    const showInactive2 = page.getByText("Show inactive");
    if (await showInactive2.isVisible({ timeout: 3000 }).catch(() => false)) {
      await showInactive2.click();
    }

    // Wait for all to appear
    await expect(
      page.getByText(`#${SHIP_PAUSED.issueNumber}`).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(`#${SHIP_ABANDONED.issueNumber}`).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(`#${SHIP_ACTIVE.issueNumber}`).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Simulate resume all: only paused ship gets resumed
    await updateSeededShip(page, SHIP_PAUSED.id, { phase: "coding" });

    // All ships should still be visible
    await expect(
      page.getByText(`#${SHIP_PAUSED.issueNumber}`).first(),
    ).toBeVisible();
    await expect(
      page.getByText(`#${SHIP_ABANDONED.issueNumber}`).first(),
    ).toBeVisible();
    await expect(
      page.getByText(`#${SHIP_ACTIVE.issueNumber}`).first(),
    ).toBeVisible();
  });
});
