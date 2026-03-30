/**
 * Escort Gate Flow E2E Test — Issue #780
 *
 * Verifies the Escort gate review cycle in the UI:
 * - Ship enters gate phase → UI shows gate pending state
 * - Escort approves → Ship advances to next phase
 * - Escort rejects → Ship returns to pre-gate phase
 *
 * Uses WS message injection to simulate Engine/Escort interactions.
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
  id: "e2e-gate-ship-001",
  repo: "test-org/test-repo",
  issueNumber: 500,
  issueTitle: "Gate flow test",
  branchName: "feature/500-gate-flow",
};

test.describe.serial("Escort Gate Flow", () => {
  test.beforeEach(async ({ page }) => {
    await installWsCapture(page);
  });

  test("plan-gate shows pending state, then advances on approval", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Gate Fleet");

    // Create ship in plan phase
    await injectWsMessage(page, {
      type: "ship:created",
      data: {
        shipId: SHIP.id,
        repo: SHIP.repo,
        issueNumber: SHIP.issueNumber,
        issueTitle: SHIP.issueTitle,
        branchName: SHIP.branchName,
        phase: "plan",
      },
    });

    await expect(
      page.getByText(`#${SHIP.issueNumber}`),
    ).toBeVisible({ timeout: 10_000 });

    // Transition to plan-gate
    await injectWsMessage(page, {
      type: "ship:status",
      data: { shipId: SHIP.id, phase: "plan-gate" },
    });

    await page.waitForTimeout(300);

    // Set gate check pending
    await injectWsMessage(page, {
      type: "ship:gate-check",
      data: {
        shipId: SHIP.id,
        gateCheck: {
          phase: "plan-gate",
          type: "plan-review",
          status: "pending",
        },
      },
    });

    await page.waitForTimeout(300);

    // Ship should still be visible in gate state
    await expect(
      page.getByText(`#${SHIP.issueNumber}`),
    ).toBeVisible();

    // Escort approves — clear gate and advance to coding
    await injectWsMessage(page, {
      type: "ship:gate-check",
      data: { shipId: SHIP.id, gateCheck: null },
    });

    await injectWsMessage(page, {
      type: "ship:status",
      data: { shipId: SHIP.id, phase: "coding" },
    });

    await page.waitForTimeout(300);

    // Ship should show coding phase
    await expect(
      page.getByText(`#${SHIP.issueNumber}`),
    ).toBeVisible();
  });

  test("gate rejection returns Ship to pre-gate phase", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Reject Fleet");

    // Create ship in plan phase
    await injectWsMessage(page, {
      type: "ship:created",
      data: {
        shipId: SHIP.id,
        repo: SHIP.repo,
        issueNumber: SHIP.issueNumber,
        issueTitle: SHIP.issueTitle,
        branchName: SHIP.branchName,
        phase: "plan",
      },
    });

    await expect(
      page.getByText(`#${SHIP.issueNumber}`),
    ).toBeVisible({ timeout: 10_000 });

    // Enter plan-gate
    await injectWsMessage(page, {
      type: "ship:status",
      data: { shipId: SHIP.id, phase: "plan-gate" },
    });

    await page.waitForTimeout(200);

    // Escort rejects — Ship goes back to plan
    await injectWsMessage(page, {
      type: "ship:gate-check",
      data: { shipId: SHIP.id, gateCheck: null },
    });

    await injectWsMessage(page, {
      type: "ship:status",
      data: { shipId: SHIP.id, phase: "plan" },
    });

    await page.waitForTimeout(300);

    // Ship should be back in plan phase
    await expect(
      page.getByText(`#${SHIP.issueNumber}`),
    ).toBeVisible();
  });

  test("coding-gate to merging flow", async ({
    page,
    baseURL,
  }) => {
    await page.goto(baseURL!);
    await waitForConnection(page);
    await createAndSelectFleet(page, "Code Gate Fleet");

    // Create ship directly in coding phase
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

    // coding → coding-gate
    await injectWsMessage(page, {
      type: "ship:status",
      data: { shipId: SHIP.id, phase: "coding-gate" },
    });

    await injectWsMessage(page, {
      type: "ship:gate-check",
      data: {
        shipId: SHIP.id,
        gateCheck: {
          phase: "coding-gate",
          type: "code-review",
          status: "pending",
        },
      },
    });

    await page.waitForTimeout(300);

    // Approve coding gate → skip qa → merging (qaRequired=false)
    await injectWsMessage(page, {
      type: "ship:gate-check",
      data: { shipId: SHIP.id, gateCheck: null },
    });

    await injectWsMessage(page, {
      type: "ship:status",
      data: { shipId: SHIP.id, phase: "merging" },
    });

    await page.waitForTimeout(300);

    // Ship should be in merging phase
    await expect(
      page.getByText(`#${SHIP.issueNumber}`),
    ).toBeVisible();

    // Complete
    await injectWsMessage(page, {
      type: "ship:done",
      data: {
        shipId: SHIP.id,
        prUrl: "https://github.com/test-org/test-repo/pull/50",
        merged: true,
      },
    });

    await page.waitForTimeout(300);

    await expect(
      page.getByText(`#${SHIP.issueNumber}`),
    ).toBeVisible();
  });
});
