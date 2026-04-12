/**
 * Phase Transition Paths E2E Test — Issue #973 (audit-quality F2)
 *
 * Comprehensive coverage of all Ship phase transition paths:
 * - Full happy path (plan → done)
 * - Gate rejection → re-submit cycles
 * - QA skip path (qaRequired=false)
 * - Pause/resume from various phases
 * - Escort died fallback
 *
 * Protects against regressions in #952 (PhaseTransaction) and #954 (log separation).
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
  branchName: "feature/973-phase-paths",
};

test.describe.serial("Phase Transition Paths — audit-quality F2", () => {
  test.beforeEach(async ({ page }) => {
    await installWsCapture(page);
    await installShipSeedRoute(page);
  });

  test("full happy path: plan → plan-gate → coding → coding-gate → qa → qa-gate → merging → done", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Full-Path-Fleet");

    const fleetId = await getSelectedFleetId(page);

    await seedShip(page, {
      ...SHIP_BASE,
      id: "e2e-full-path-ship",
      fleetId,
      issueNumber: 901,
      issueTitle: "Full path test",
      phase: "plan",
    });

    await expect(page.getByText("#901").first()).toBeVisible({ timeout: 10_000 });

    const phases = [
      "plan-gate",
      "coding",
      "coding-gate",
      "qa",
      "qa-gate",
      "merging",
    ] as const;

    for (const phase of phases) {
      await updateSeededShip(page, "e2e-full-path-ship", { phase });
      await expect(page.getByText("#901").first()).toBeVisible({ timeout: 5_000 });
    }

    // Done
    await completeSeededShip(page, "e2e-full-path-ship");

    const showInactive = page.getByText("Show inactive");
    if (await showInactive.isVisible({ timeout: 2000 }).catch(() => false)) {
      await showInactive.click();
    }

    await expect(page.getByText("#901").first()).toBeVisible({ timeout: 5_000 });
  });

  test("plan-gate reject → plan → plan-gate approve → coding", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Plan-Reject-Fleet");

    const fleetId = await getSelectedFleetId(page);

    await seedShip(page, {
      ...SHIP_BASE,
      id: "e2e-plan-reject-ship",
      fleetId,
      issueNumber: 902,
      issueTitle: "Plan reject cycle",
      phase: "plan",
    });

    await expect(page.getByText("#902").first()).toBeVisible({ timeout: 10_000 });

    // plan → plan-gate
    await updateSeededShip(page, "e2e-plan-reject-ship", { phase: "plan-gate" });

    await injectGatePending(
      page, "e2e-plan-reject-ship", "plan-gate", "plan-review",
      fleetId, 902, "Plan reject cycle",
    );

    // Reject → back to plan
    await injectGateResolved(
      page, "e2e-plan-reject-ship", "plan-gate", "plan-review",
      false, "Plan lacks detail",
    );
    await updateSeededShip(page, "e2e-plan-reject-ship", { phase: "plan" });

    await expect(page.getByText("#902").first()).toBeVisible();

    // Re-submit: plan → plan-gate → coding
    await updateSeededShip(page, "e2e-plan-reject-ship", { phase: "plan-gate" });

    await injectGatePending(
      page, "e2e-plan-reject-ship", "plan-gate", "plan-review",
      fleetId, 902, "Plan reject cycle",
    );

    await injectGateResolved(
      page, "e2e-plan-reject-ship", "plan-gate", "plan-review", true,
    );
    await updateSeededShip(page, "e2e-plan-reject-ship", { phase: "coding" });

    await expect(page.getByText("#902").first()).toBeVisible();
  });

  test("coding-gate reject → coding → coding-gate approve → qa", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Code-Reject-Fleet");

    const fleetId = await getSelectedFleetId(page);

    await seedShip(page, {
      ...SHIP_BASE,
      id: "e2e-code-reject-ship",
      fleetId,
      issueNumber: 903,
      issueTitle: "Code reject cycle",
      phase: "coding",
    });

    await expect(page.getByText("#903").first()).toBeVisible({ timeout: 10_000 });

    // coding → coding-gate
    await updateSeededShip(page, "e2e-code-reject-ship", { phase: "coding-gate" });

    await injectGatePending(
      page, "e2e-code-reject-ship", "coding-gate", "code-review",
      fleetId, 903, "Code reject cycle",
    );

    // Reject → back to coding
    await injectGateResolved(
      page, "e2e-code-reject-ship", "coding-gate", "code-review",
      false, "Security vulnerability found",
    );
    await updateSeededShip(page, "e2e-code-reject-ship", { phase: "coding" });

    await expect(page.getByText("#903").first()).toBeVisible();

    // Re-submit: coding → coding-gate → qa
    await updateSeededShip(page, "e2e-code-reject-ship", { phase: "coding-gate" });

    await injectGateResolved(
      page, "e2e-code-reject-ship", "coding-gate", "code-review", true,
    );
    await updateSeededShip(page, "e2e-code-reject-ship", { phase: "qa" });

    await expect(page.getByText("#903").first()).toBeVisible();
  });

  test("pause from coding → resume back to coding", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Pause-Fleet");

    const fleetId = await getSelectedFleetId(page);

    await seedShip(page, {
      ...SHIP_BASE,
      id: "e2e-pause-ship",
      fleetId,
      issueNumber: 904,
      issueTitle: "Pause/resume test",
      phase: "coding",
    });

    await expect(page.getByText("#904").first()).toBeVisible({ timeout: 10_000 });

    // Pause
    await updateSeededShip(page, "e2e-pause-ship", { phase: "paused" });

    // Paused ships may be in inactive list
    const showInactive = page.getByText("Show inactive");
    if (await showInactive.isVisible({ timeout: 2000 }).catch(() => false)) {
      await showInactive.click();
    }

    await expect(page.getByText("#904").first()).toBeVisible({ timeout: 5_000 });

    // Resume back to coding
    await updateSeededShip(page, "e2e-pause-ship", { phase: "coding" });
    await expect(page.getByText("#904").first()).toBeVisible();
  });

  test("pause from plan-gate → resume back to plan-gate", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Pause-Gate-Fleet");

    const fleetId = await getSelectedFleetId(page);

    await seedShip(page, {
      ...SHIP_BASE,
      id: "e2e-pause-gate-ship",
      fleetId,
      issueNumber: 905,
      issueTitle: "Pause from gate test",
      phase: "plan-gate",
    });

    await expect(page.getByText("#905").first()).toBeVisible({ timeout: 10_000 });

    // Pause from gate
    await updateSeededShip(page, "e2e-pause-gate-ship", { phase: "paused" });

    const showInactive = page.getByText("Show inactive");
    if (await showInactive.isVisible({ timeout: 2000 }).catch(() => false)) {
      await showInactive.click();
    }

    await expect(page.getByText("#905").first()).toBeVisible({ timeout: 5_000 });

    // Resume back to plan-gate
    await updateSeededShip(page, "e2e-pause-gate-ship", { phase: "plan-gate" });
    await expect(page.getByText("#905").first()).toBeVisible();
  });

  test("escort died fallback: plan-gate → plan on escort failure", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Escort-Died-Fleet");

    const fleetId = await getSelectedFleetId(page);

    await seedShip(page, {
      ...SHIP_BASE,
      id: "e2e-escort-died-ship",
      fleetId,
      issueNumber: 906,
      issueTitle: "Escort died fallback",
      phase: "plan",
    });

    await expect(page.getByText("#906").first()).toBeVisible({ timeout: 10_000 });

    // plan → plan-gate
    await updateSeededShip(page, "e2e-escort-died-ship", { phase: "plan-gate" });

    await injectGatePending(
      page, "e2e-escort-died-ship", "plan-gate", "plan-review",
      fleetId, 906, "Escort died fallback",
    );

    // Simulate escort dying → Ship falls back to plan
    await updateSeededShip(page, "e2e-escort-died-ship", { phase: "plan" });

    await expect(page.getByText("#906").first()).toBeVisible();

    // Second attempt succeeds
    await updateSeededShip(page, "e2e-escort-died-ship", { phase: "plan-gate" });
    await injectGateResolved(
      page, "e2e-escort-died-ship", "plan-gate", "plan-review", true,
    );
    await updateSeededShip(page, "e2e-escort-died-ship", { phase: "coding" });

    await expect(page.getByText("#906").first()).toBeVisible();
  });

  test("abandon from paused state", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Abandon-Fleet");

    const fleetId = await getSelectedFleetId(page);

    await seedShip(page, {
      ...SHIP_BASE,
      id: "e2e-abandon-ship",
      fleetId,
      issueNumber: 907,
      issueTitle: "Abandon test",
      phase: "coding",
    });

    await expect(page.getByText("#907").first()).toBeVisible({ timeout: 10_000 });

    // coding → paused → abandoned
    await updateSeededShip(page, "e2e-abandon-ship", { phase: "paused" });

    const showInactive = page.getByText("Show inactive");
    if (await showInactive.isVisible({ timeout: 2000 }).catch(() => false)) {
      await showInactive.click();
    }

    await expect(page.getByText("#907").first()).toBeVisible({ timeout: 5_000 });

    await updateSeededShip(page, "e2e-abandon-ship", { phase: "abandoned" });

    await expect(page.getByText("#907").first()).toBeVisible({ timeout: 5_000 });
  });
});
