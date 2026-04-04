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
  installShipSeedRoute,
  seedShip,
  updateSeededShip,
  completeSeededShip,
  getSelectedFleetId,
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
    await installShipSeedRoute(page);
  });

  test("multiple Ships appear independently in UI", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Parallel Fleet");

    const fleetId = await getSelectedFleetId(page);

    // Create all three ships
    for (const ship of SHIPS) {
      await seedShip(page, {
        ...ship,
        fleetId,
        phase: "plan",
      });
    }

    // All three ships should be visible
    for (const ship of SHIPS) {
      await expect(
        page.getByText(`#${ship.issueNumber}`).first(),
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

    const fleetId = await getSelectedFleetId(page);

    // Create two ships in plan phase
    for (const ship of SHIPS.slice(0, 2)) {
      await seedShip(page, {
        ...ship,
        fleetId,
        phase: "plan",
      });
    }

    // Wait for both to appear
    await expect(
      page.getByText(`#${SHIPS[0].issueNumber}`).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(`#${SHIPS[1].issueNumber}`).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Advance Ship A to coding, Ship B stays in plan
    await updateSeededShip(page, SHIPS[0].id, { phase: "coding" });

    // Both ships should still be visible
    await expect(
      page.getByText(`#${SHIPS[0].issueNumber}`).first(),
    ).toBeVisible();
    await expect(
      page.getByText(`#${SHIPS[1].issueNumber}`).first(),
    ).toBeVisible();
  });

  test("completing one Ship does not remove others", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Complete Fleet");

    const fleetId = await getSelectedFleetId(page);

    // Create two ships
    for (const ship of SHIPS.slice(0, 2)) {
      await seedShip(page, {
        ...ship,
        fleetId,
        phase: "coding",
      });
    }

    await expect(
      page.getByText(`#${SHIPS[0].issueNumber}`).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Complete Ship A
    await completeSeededShip(page, SHIPS[0].id);

    // Ship B should still be visible and unaffected
    await expect(
      page.getByText(`#${SHIPS[1].issueNumber}`).first(),
    ).toBeVisible();
  });

  test("rapid phase updates on multiple Ships are handled correctly", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Rapid Fleet");

    const fleetId = await getSelectedFleetId(page);

    // Create all three ships
    for (const ship of SHIPS) {
      await seedShip(page, {
        ...ship,
        fleetId,
        phase: "plan",
      });
    }

    // Wait for all to appear
    for (const ship of SHIPS) {
      await expect(
        page.getByText(`#${ship.issueNumber}`).first(),
      ).toBeVisible({ timeout: 10_000 });
    }

    // Rapid fire phase updates for all ships simultaneously
    const phases = ["plan-gate", "coding", "coding-gate", "merging"] as const;
    for (const phase of phases) {
      for (const ship of SHIPS) {
        await updateSeededShip(page, ship.id, { phase });
      }
    }

    // After rapid updates, all ships should still be visible
    for (const ship of SHIPS) {
      await expect(
        page.getByText(`#${ship.issueNumber}`).first(),
      ).toBeVisible();
    }
  });
});
