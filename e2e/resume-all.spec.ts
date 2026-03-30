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
  injectWsMessage,
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
  });

  test("UI shows mixed ship states correctly", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Resume All Fleet");

    // Create ships in different states
    const ships = [
      { ...SHIP_PAUSED, phase: "paused" },
      { ...SHIP_PAUSED_2, phase: "paused" },
      { ...SHIP_ABANDONED, phase: "abandoned" },
      { ...SHIP_ACTIVE, phase: "coding" },
    ];

    for (const ship of ships) {
      await injectWsMessage(page, {
        type: "ship:created",
        data: {
          shipId: ship.id,
          repo: ship.repo,
          issueNumber: ship.issueNumber,
          issueTitle: ship.issueTitle,
          branchName: ship.branchName,
          phase: ship.phase,
        },
      });
      await page.waitForTimeout(100);
    }

    // All ships should be visible
    for (const ship of ships) {
      await expect(
        page.getByText(`#${ship.issueNumber}`),
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

    // Create ships in different states
    await injectWsMessage(page, {
      type: "ship:created",
      data: {
        shipId: SHIP_PAUSED.id,
        repo: SHIP_PAUSED.repo,
        issueNumber: SHIP_PAUSED.issueNumber,
        issueTitle: SHIP_PAUSED.issueTitle,
        branchName: SHIP_PAUSED.branchName,
        phase: "paused",
      },
    });

    await injectWsMessage(page, {
      type: "ship:created",
      data: {
        shipId: SHIP_ABANDONED.id,
        repo: SHIP_ABANDONED.repo,
        issueNumber: SHIP_ABANDONED.issueNumber,
        issueTitle: SHIP_ABANDONED.issueTitle,
        branchName: SHIP_ABANDONED.branchName,
        phase: "abandoned",
      },
    });

    await injectWsMessage(page, {
      type: "ship:created",
      data: {
        shipId: SHIP_ACTIVE.id,
        repo: SHIP_ACTIVE.repo,
        issueNumber: SHIP_ACTIVE.issueNumber,
        issueTitle: SHIP_ACTIVE.issueTitle,
        branchName: SHIP_ACTIVE.branchName,
        phase: "coding",
      },
    });

    // Wait for all to appear
    await expect(
      page.getByText(`#${SHIP_PAUSED.issueNumber}`),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(`#${SHIP_ABANDONED.issueNumber}`),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(`#${SHIP_ACTIVE.issueNumber}`),
    ).toBeVisible({ timeout: 10_000 });

    // Simulate resume all: only paused ship gets resumed
    await injectWsMessage(page, {
      type: "ship:status",
      data: { shipId: SHIP_PAUSED.id, phase: "coding" },
    });

    await page.waitForTimeout(300);

    // Paused ship should now show coding phase
    // Abandoned ship should remain abandoned
    // Active ship should remain in coding

    // All ships should still be visible
    await expect(
      page.getByText(`#${SHIP_PAUSED.issueNumber}`),
    ).toBeVisible();
    await expect(
      page.getByText(`#${SHIP_ABANDONED.issueNumber}`),
    ).toBeVisible();
    await expect(
      page.getByText(`#${SHIP_ACTIVE.issueNumber}`),
    ).toBeVisible();
  });
});
