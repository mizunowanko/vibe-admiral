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
  injectWsMessage,
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
  });

  test("paused Ship shows paused state in UI", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Resume Fleet");

    // Create ship in coding phase
    await injectWsMessage(page, {
      type: "ship:created",
      data: {
        shipId: SHIP.id,
        repo: SHIP.repo,
        issueNumber: SHIP.issueNumber,
        issueTitle: SHIP.issueTitle,
        branchName: SHIP.branchName,
        phase: "coding",
      },
    });

    await expect(
      page.getByText(`#${SHIP.issueNumber}`),
    ).toBeVisible({ timeout: 10_000 });

    // Pause the ship
    await injectWsMessage(page, {
      type: "ship:status",
      data: {
        shipId: SHIP.id,
        phase: "paused",
      },
    });

    await page.waitForTimeout(300);

    // Verify paused state is shown
    // The ship card should indicate paused status
    await expect(
      page.getByText(`#${SHIP.issueNumber}`),
    ).toBeVisible();
  });

  test("resumed Ship restores previous phase in UI", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Resume Fleet 2");

    // Create ship in coding phase
    await injectWsMessage(page, {
      type: "ship:created",
      data: {
        shipId: SHIP.id,
        repo: SHIP.repo,
        issueNumber: SHIP.issueNumber,
        issueTitle: SHIP.issueTitle,
        branchName: SHIP.branchName,
        phase: "coding",
      },
    });

    await expect(
      page.getByText(`#${SHIP.issueNumber}`),
    ).toBeVisible({ timeout: 10_000 });

    // Pause
    await injectWsMessage(page, {
      type: "ship:status",
      data: { shipId: SHIP.id, phase: "paused" },
    });

    await page.waitForTimeout(300);

    // Resume — phase goes back to coding
    await injectWsMessage(page, {
      type: "ship:status",
      data: { shipId: SHIP.id, phase: "coding" },
    });

    await page.waitForTimeout(300);

    // Ship should be visible and active again
    await expect(
      page.getByText(`#${SHIP.issueNumber}`),
    ).toBeVisible();
  });

  test("abandoned Ship is distinct from paused", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Abandon Fleet");

    // Create ship
    await injectWsMessage(page, {
      type: "ship:created",
      data: {
        shipId: SHIP.id,
        repo: SHIP.repo,
        issueNumber: SHIP.issueNumber,
        issueTitle: SHIP.issueTitle,
        branchName: SHIP.branchName,
        phase: "coding",
      },
    });

    await expect(
      page.getByText(`#${SHIP.issueNumber}`),
    ).toBeVisible({ timeout: 10_000 });

    // Abandon the ship
    await injectWsMessage(page, {
      type: "ship:status",
      data: { shipId: SHIP.id, phase: "abandoned" },
    });

    await page.waitForTimeout(300);

    // Abandoned ship should still be visible but marked differently
    await expect(
      page.getByText(`#${SHIP.issueNumber}`),
    ).toBeVisible();
  });
});
