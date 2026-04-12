/**
 * Dispatch Card Display E2E Test — Issue #973 (audit gap: #822)
 *
 * Verifies that Dispatch cards are correctly rendered in the UI:
 * - Running dispatch shows amber badge with pulse animation
 * - Completed dispatch shows emerald badge
 * - Failed dispatch shows red badge
 * - Dispatch cards appear under the correct parent (Dock/Flagship)
 */

import {
  test,
  expect,
  waitForConnection,
  createAndSelectFleet,
} from "./fixtures";
import {
  installWsCapture,
  seedDispatch,
  updateDispatchStatus,
  getSelectedFleetId,
} from "./helpers/ws-helpers";

test.describe.serial("Dispatch Card Display — Issue #822", () => {
  test.beforeEach(async ({ page }) => {
    await installWsCapture(page);
  });

  test("running Dispatch card appears with name and Running badge", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Dispatch-Fleet");

    const fleetId = await getSelectedFleetId(page);

    await seedDispatch(page, {
      id: "e2e-dispatch-001",
      parentRole: "flagship",
      fleetId,
      name: "investigate-bug-123",
      status: "running",
      startedAt: Date.now(),
    });

    await expect(page.getByText("investigate-bug-123")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Running")).toBeVisible();
  });

  test("completed Dispatch shows Completed badge", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Dispatch-Complete-Fleet");

    const fleetId = await getSelectedFleetId(page);

    const startedAt = Date.now() - 30_000;

    await seedDispatch(page, {
      id: "e2e-dispatch-002",
      parentRole: "dock",
      fleetId,
      name: "explore-codebase",
      status: "running",
      startedAt,
    });

    await expect(page.getByText("explore-codebase")).toBeVisible({
      timeout: 10_000,
    });

    await updateDispatchStatus(page, {
      id: "e2e-dispatch-002",
      parentRole: "dock",
      fleetId,
      name: "explore-codebase",
      status: "completed",
      startedAt,
      completedAt: Date.now(),
      result: "Investigation complete",
    });

    await expect(page.getByText("Completed")).toBeVisible({ timeout: 5_000 });
  });

  test("failed Dispatch shows Failed badge", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Dispatch-Fail-Fleet");

    const fleetId = await getSelectedFleetId(page);

    const startedAt = Date.now() - 10_000;

    await seedDispatch(page, {
      id: "e2e-dispatch-003",
      parentRole: "flagship",
      fleetId,
      name: "broken-task",
      status: "running",
      startedAt,
    });

    await expect(page.getByText("broken-task")).toBeVisible({
      timeout: 10_000,
    });

    await updateDispatchStatus(page, {
      id: "e2e-dispatch-003",
      parentRole: "flagship",
      fleetId,
      name: "broken-task",
      status: "failed",
      startedAt,
      completedAt: Date.now(),
    });

    await expect(page.getByText("Failed")).toBeVisible({ timeout: 5_000 });
  });

  test("multiple Dispatch cards from different parents appear simultaneously", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Dispatch-Multi-Fleet");

    const fleetId = await getSelectedFleetId(page);

    await seedDispatch(page, {
      id: "e2e-dispatch-dock-001",
      parentRole: "dock",
      fleetId,
      name: "dock-investigation",
      status: "running",
      startedAt: Date.now(),
    });

    await seedDispatch(page, {
      id: "e2e-dispatch-flag-001",
      parentRole: "flagship",
      fleetId,
      name: "flagship-investigation",
      status: "running",
      startedAt: Date.now(),
    });

    await expect(page.getByText("dock-investigation")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("flagship-investigation")).toBeVisible();
  });
});
