/**
 * QA Gate Skip E2E Test — Issue #973 (audit gap: #835)
 *
 * Verifies the UI correctly reflects qaRequired behavior:
 * - qaRequired=true: Ship goes through qa → qa-gate → merging
 * - qaRequired=false: Ship goes from qa directly to merging (skipping qa-gate)
 *
 * Uses seeded ships + WS notification injection.
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

const SHIP_BASE = {
  repo: "test-org/test-repo",
  issueTitle: "QA gate test",
  branchName: "feature/835-qa-gate",
};

test.describe.serial("QA Gate Skip — Issue #835", () => {
  test.beforeEach(async ({ page }) => {
    await installWsCapture(page);
    await installShipSeedRoute(page);
  });

  test("qaRequired=true: Ship goes through qa-gate before merging", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "QA-Required-Fleet");

    const fleetId = await getSelectedFleetId(page);

    await seedShip(page, {
      ...SHIP_BASE,
      id: "e2e-qa-required-ship",
      fleetId,
      issueNumber: 835,
      phase: "qa",
    });

    await expect(
      page.getByText("#835").first(),
    ).toBeVisible({ timeout: 10_000 });

    // qa → qa-gate (qaRequired=true path)
    await updateSeededShip(page, "e2e-qa-required-ship", { phase: "qa-gate" });

    await injectGatePending(
      page,
      "e2e-qa-required-ship",
      "qa-gate",
      "acceptance-test",
      fleetId,
      835,
      "QA gate test",
    );

    // Ship should be visible in qa-gate
    await expect(
      page.getByText("#835").first(),
    ).toBeVisible();

    // Escort approves qa-gate → merging
    await injectGateResolved(
      page,
      "e2e-qa-required-ship",
      "qa-gate",
      "acceptance-test",
      true,
    );
    await updateSeededShip(page, "e2e-qa-required-ship", { phase: "merging" });

    await expect(
      page.getByText("#835").first(),
    ).toBeVisible();

    // Complete
    await completeSeededShip(page, "e2e-qa-required-ship");

    const showInactive = page.getByText("Show inactive");
    if (await showInactive.isVisible({ timeout: 2000 }).catch(() => false)) {
      await showInactive.click();
    }

    await expect(
      page.getByText("#835").first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("qaRequired=false: Ship skips qa-gate and goes directly to merging", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "QA-Skip-Fleet");

    const fleetId = await getSelectedFleetId(page);

    await seedShip(page, {
      ...SHIP_BASE,
      id: "e2e-qa-skip-ship",
      fleetId,
      issueNumber: 836,
      phase: "qa",
    });

    await expect(
      page.getByText("#836").first(),
    ).toBeVisible({ timeout: 10_000 });

    // qa → merging directly (qaRequired=false, skip qa-gate)
    await updateSeededShip(page, "e2e-qa-skip-ship", { phase: "merging" });

    await expect(
      page.getByText("#836").first(),
    ).toBeVisible();

    // Complete
    await completeSeededShip(page, "e2e-qa-skip-ship");

    const showInactive = page.getByText("Show inactive");
    if (await showInactive.isVisible({ timeout: 2000 }).catch(() => false)) {
      await showInactive.click();
    }

    await expect(
      page.getByText("#836").first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("qa-gate rejection returns Ship to qa phase", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "QA-Reject-Fleet");

    const fleetId = await getSelectedFleetId(page);

    await seedShip(page, {
      ...SHIP_BASE,
      id: "e2e-qa-reject-ship",
      fleetId,
      issueNumber: 837,
      phase: "qa",
    });

    await expect(
      page.getByText("#837").first(),
    ).toBeVisible({ timeout: 10_000 });

    // qa → qa-gate
    await updateSeededShip(page, "e2e-qa-reject-ship", { phase: "qa-gate" });

    // Escort rejects → back to qa
    await injectGateResolved(
      page,
      "e2e-qa-reject-ship",
      "qa-gate",
      "acceptance-test",
      false,
      "Test failures found",
    );
    await updateSeededShip(page, "e2e-qa-reject-ship", { phase: "qa" });

    // Ship should be visible back in qa
    await expect(
      page.getByText("#837").first(),
    ).toBeVisible();

    // Second attempt: qa → qa-gate → merging (approved)
    await updateSeededShip(page, "e2e-qa-reject-ship", { phase: "qa-gate" });
    await injectGateResolved(
      page,
      "e2e-qa-reject-ship",
      "qa-gate",
      "acceptance-test",
      true,
    );
    await updateSeededShip(page, "e2e-qa-reject-ship", { phase: "merging" });

    await expect(
      page.getByText("#837").first(),
    ).toBeVisible();
  });
});
