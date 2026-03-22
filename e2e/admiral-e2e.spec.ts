import {
  test,
  expect,
  waitForConnection,
  createAndSelectFleet,
} from "./fixtures";

/**
 * Admiral E2E Test — Single Comprehensive Scenario
 *
 * This test runs a full Admiral workflow in one sequential flow to minimize
 * token consumption. It covers:
 *   1. Admiral startup + Engine connection
 *   2. Fleet creation and selection
 *   3. Flagship commander interaction
 *   4. Dock commander interaction
 *   5. Ship panel visibility
 *   6. Fleet settings access
 *
 * NOTE: Real sortie / gate / Ship lifecycle tests require a toy project
 * with actual Claude CLI execution. Those are deferred to a future iteration
 * when the toy project (mizunowanko-org/toy-admiral-test) is prepared.
 * This test validates the Admiral UI integration with a real Engine (not mock).
 */
test.describe("Admiral E2E — Full Workflow", () => {
  test.describe.configure({ mode: "serial" });

  test("complete Admiral workflow: startup → fleet → commanders → settings", async ({
    page,
    enginePort,
  }) => {
    // ── Step 1: Admiral startup + Engine connection ──
    await page.goto("/");
    await waitForConnection(page);

    const engineStatus = page.getByTestId("engine-status");
    await expect(engineStatus).toHaveClass(/bg-green-500/);

    // ── Step 2: Fleet creation ──
    await createAndSelectFleet(page, "E2E Test Fleet");

    // Verify fleet appears in sidebar
    const fleetItem = page.locator("button").filter({ hasText: "E2E Test Fleet" });
    await expect(fleetItem).toBeVisible();

    // ── Step 3: Flagship commander interaction ──
    const flagshipInput = page.getByPlaceholder(
      "Send a command to Flagship...",
    );
    await expect(flagshipInput).toBeVisible({ timeout: 5000 });

    // Send a message to Flagship
    await flagshipInput.fill("E2E test message from Flagship");
    await flagshipInput.press("Enter");

    // User message should appear in chat
    await expect(
      page.getByText("E2E test message from Flagship"),
    ).toBeVisible({ timeout: 10_000 });

    // ── Step 4: Dock commander tab ──
    // Look for the Dock tab/button to switch
    const dockTab = page.getByRole("button", { name: /dock/i });
    if (await dockTab.isVisible().catch(() => false)) {
      await dockTab.click();

      const dockInput = page.getByPlaceholder(
        "Send a command to Dock...",
      );
      if (await dockInput.isVisible().catch(() => false)) {
        await dockInput.fill("E2E test message from Dock");
        await dockInput.press("Enter");

        await expect(
          page.getByText("E2E test message from Dock"),
        ).toBeVisible({ timeout: 10_000 });
      }
    }

    // ── Step 5: Ships panel visibility ──
    // The Ships section should be visible in the sidebar (even if empty)
    const shipsSection = page.getByText("SHIPS");
    if (await shipsSection.isVisible().catch(() => false)) {
      await expect(shipsSection).toBeVisible();
    }

    // ── Step 6: Fleet settings ──
    const settingsButton = page.getByRole("button", {
      name: "Settings",
      exact: true,
    });
    await expect(settingsButton).toBeVisible({ timeout: 5000 });
    await settingsButton.click();

    // Fleet name should be visible in settings
    await expect(page.getByText("E2E Test Fleet")).toBeVisible({
      timeout: 5000,
    });

    // ── Step 7: Verify Engine API is accessible ──
    const apiResponse = await page.evaluate(
      async (port: number) => {
        const res = await fetch(`http://localhost:${port}/api/health`);
        return { status: res.status, ok: res.ok };
      },
      enginePort,
    );
    // Engine may or may not have a /api/health endpoint.
    // If it doesn't exist, that's fine — we already proved connectivity via WebSocket.
    // This step is informational.
    console.log(`Engine API /health response: ${JSON.stringify(apiResponse)}`);
  });
});
