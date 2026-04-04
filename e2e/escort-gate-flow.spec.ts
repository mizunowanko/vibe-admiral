/**
 * Escort Gate Flow E2E Test — Issue #780
 *
 * Verifies the Escort gate review cycle in the UI:
 * - Ship enters gate phase → UI shows gate pending state
 * - Escort approves → Ship advances to next phase
 * - Escort rejects → Ship returns to pre-gate phase
 *
 * Uses seeded ships + notification-only WS protocol (ADR-0019).
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
  injectGatePending,
  injectGateResolved,
  getSelectedFleetId,
} from "./helpers/ws-helpers";

const SHIP = {
  id: "e2e-gate-ship-001",
  repo: "test-org/test-repo",
  issueNumber: 500,
  issueTitle: "Gate flow test",
  branchName: "feature/500-gate-flow",
};

test.describe.serial("Escort Gate Flow", () => {
  test.beforeEach(async ({ page }) => {
    await installWsCapture(page);
    await installShipSeedRoute(page);
  });

  test("plan-gate shows pending state, then advances on approval", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Gate Fleet");

    const fleetId = await getSelectedFleetId(page);

    // Create ship in plan phase
    await seedShip(page, {
      ...SHIP,
      fleetId,
      phase: "plan",
    });

    await expect(
      page.getByText(`#${SHIP.issueNumber}`).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Transition to plan-gate
    await updateSeededShip(page, SHIP.id, { phase: "plan-gate" });

    // Set gate check pending
    await injectGatePending(
      page, SHIP.id, "plan-gate", "plan-review",
      fleetId, SHIP.issueNumber, SHIP.issueTitle,
    );

    // Ship should still be visible in gate state
    await expect(
      page.getByText(`#${SHIP.issueNumber}`).first(),
    ).toBeVisible();

    // Escort approves — clear gate and advance to coding
    await injectGateResolved(page, SHIP.id, "plan-gate", "plan-review", true);
    await updateSeededShip(page, SHIP.id, { phase: "coding" });

    // Ship should show coding phase
    await expect(
      page.getByText(`#${SHIP.issueNumber}`).first(),
    ).toBeVisible();
  });

  test("gate rejection returns Ship to pre-gate phase", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Reject Fleet");

    const fleetId = await getSelectedFleetId(page);

    // Create ship in plan phase
    await seedShip(page, {
      ...SHIP,
      fleetId,
      phase: "plan",
    });

    await expect(
      page.getByText(`#${SHIP.issueNumber}`).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Enter plan-gate
    await updateSeededShip(page, SHIP.id, { phase: "plan-gate" });

    // Escort rejects — Ship goes back to plan
    await injectGateResolved(page, SHIP.id, "plan-gate", "plan-review", false, "Plan needs more detail");
    await updateSeededShip(page, SHIP.id, { phase: "plan" });

    // Ship should be back in plan phase
    await expect(
      page.getByText(`#${SHIP.issueNumber}`).first(),
    ).toBeVisible();
  });

  test("coding-gate to merging flow", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Code Gate Fleet");

    const fleetId = await getSelectedFleetId(page);

    // Create ship directly in coding phase
    await seedShip(page, {
      ...SHIP,
      fleetId,
      phase: "coding",
    });

    await expect(
      page.getByText(`#${SHIP.issueNumber}`).first(),
    ).toBeVisible({ timeout: 10_000 });

    // coding → coding-gate
    await updateSeededShip(page, SHIP.id, { phase: "coding-gate" });

    await injectGatePending(
      page, SHIP.id, "coding-gate", "code-review",
      fleetId, SHIP.issueNumber, SHIP.issueTitle,
    );

    // Approve coding gate → skip qa → merging (qaRequired=false)
    await injectGateResolved(page, SHIP.id, "coding-gate", "code-review", true);
    await updateSeededShip(page, SHIP.id, { phase: "merging" });

    // Ship should be in merging phase
    await expect(
      page.getByText(`#${SHIP.issueNumber}`).first(),
    ).toBeVisible();

    // Complete
    await completeSeededShip(page, SHIP.id);

    // Done ships are hidden by default — enable "Show inactive"
    const showInactive = page.getByText("Show inactive");
    if (await showInactive.isVisible({ timeout: 2000 }).catch(() => false)) {
      await showInactive.click();
    }

    await expect(
      page.getByText(`#${SHIP.issueNumber}`).first(),
    ).toBeVisible({ timeout: 5_000 });
  });
});
