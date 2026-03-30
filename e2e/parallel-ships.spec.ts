/**
 * Parallel Ships E2E Test — Issue #780
 *
 * Verifies that multiple Ships running in parallel don't interfere
 * with each other in the UI. Phase transitions on one Ship should
 * not affect the display of other Ships.
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

const SHIPS = [
  {
    id: "e2e-parallel-ship-001",
    repo: "test-org/repo-alpha",
    issueNumber: 401,
    issueTitle: "Parallel ship A",
    branchName: "feature/401-parallel-a",
  },
  {
    id: "e2e-parallel-ship-002",
    repo: "test-org/repo-alpha",
    issueNumber: 402,
    issueTitle: "Parallel ship B",
    branchName: "feature/402-parallel-b",
  },
  {
    id: "e2e-parallel-ship-003",
    repo: "test-org/repo-beta",
    issueNumber: 403,
    issueTitle: "Parallel ship C",
    branchName: "feature/403-parallel-c",
  },
];

test.describe.serial("Parallel Ships — No Interference", () => {
  test.beforeEach(async ({ page }) => {
    await installWsCapture(page);
  });

  test("multiple Ships appear independently in UI", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Parallel Fleet");

    // Create all three ships
    for (const ship of SHIPS) {
      await injectWsMessage(page, {
        type: "ship:created",
        data: {
          shipId: ship.id,
          repo: ship.repo,
          issueNumber: ship.issueNumber,
          issueTitle: ship.issueTitle,
          branchName: ship.branchName,
          phase: "plan",
        },
      });
      await page.waitForTimeout(100);
    }

    // All three ships should be visible
    for (const ship of SHIPS) {
      await expect(
        page.getByText(`#${ship.issueNumber}`),
      ).toBeVisible({ timeout: 10_000 });
    }
  });

  test("phase change on one Ship does not affect others", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "No Interference Fleet");

    // Create two ships in plan phase
    for (const ship of SHIPS.slice(0, 2)) {
      await injectWsMessage(page, {
        type: "ship:created",
        data: {
          shipId: ship.id,
          repo: ship.repo,
          issueNumber: ship.issueNumber,
          issueTitle: ship.issueTitle,
          branchName: ship.branchName,
          phase: "plan",
        },
      });
      await page.waitForTimeout(100);
    }

    // Wait for both to appear
    await expect(
      page.getByText(`#${SHIPS[0].issueNumber}`),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(`#${SHIPS[1].issueNumber}`),
    ).toBeVisible({ timeout: 10_000 });

    // Advance Ship A to coding, Ship B stays in plan
    await injectWsMessage(page, {
      type: "ship:status",
      data: { shipId: SHIPS[0].id, phase: "coding" },
    });
    await page.waitForTimeout(300);

    // Both ships should still be visible
    await expect(
      page.getByText(`#${SHIPS[0].issueNumber}`),
    ).toBeVisible();
    await expect(
      page.getByText(`#${SHIPS[1].issueNumber}`),
    ).toBeVisible();
  });

  test("completing one Ship does not remove others", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Complete Fleet");

    // Create two ships
    for (const ship of SHIPS.slice(0, 2)) {
      await injectWsMessage(page, {
        type: "ship:created",
        data: {
          shipId: ship.id,
          repo: ship.repo,
          issueNumber: ship.issueNumber,
          issueTitle: ship.issueTitle,
          branchName: ship.branchName,
          phase: "coding",
        },
      });
      await page.waitForTimeout(100);
    }

    await expect(
      page.getByText(`#${SHIPS[0].issueNumber}`),
    ).toBeVisible({ timeout: 10_000 });

    // Complete Ship A
    await injectWsMessage(page, {
      type: "ship:done",
      data: {
        shipId: SHIPS[0].id,
        prUrl: "https://github.com/test-org/repo-alpha/pull/1",
        merged: true,
      },
    });
    await page.waitForTimeout(300);

    // Ship B should still be visible and unaffected
    await expect(
      page.getByText(`#${SHIPS[1].issueNumber}`),
    ).toBeVisible();
  });

  test("rapid phase updates on multiple Ships are handled correctly", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Rapid Fleet");

    // Create all three ships
    for (const ship of SHIPS) {
      await injectWsMessage(page, {
        type: "ship:created",
        data: {
          shipId: ship.id,
          repo: ship.repo,
          issueNumber: ship.issueNumber,
          issueTitle: ship.issueTitle,
          branchName: ship.branchName,
          phase: "plan",
        },
      });
    }

    // Wait for all to appear
    for (const ship of SHIPS) {
      await expect(
        page.getByText(`#${ship.issueNumber}`),
      ).toBeVisible({ timeout: 10_000 });
    }

    // Rapid fire phase updates for all ships simultaneously
    const phases = ["plan-gate", "coding", "coding-gate", "merging"];
    for (const phase of phases) {
      // Update all ships in rapid succession
      for (const ship of SHIPS) {
        await injectWsMessage(page, {
          type: "ship:status",
          data: { shipId: ship.id, phase },
        });
      }
      await page.waitForTimeout(100);
    }

    // After rapid updates, all ships should still be visible
    for (const ship of SHIPS) {
      await expect(
        page.getByText(`#${ship.issueNumber}`),
      ).toBeVisible();
    }
  });
});
