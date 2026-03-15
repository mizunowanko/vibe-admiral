import { test, expect, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

/**
 * Reset mock engine state via a special WebSocket message.
 * This ensures test isolation by clearing accumulated fleets.
 */
async function resetMockEngine(page: Page) {
  await page.evaluate(() => {
    const ws = new WebSocket("ws://localhost:9720");
    return new Promise<void>((resolve) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "__test:reset" }));
        ws.close();
        resolve();
      };
      ws.onerror = () => resolve();
    });
  });
}

test.describe("Connection", () => {
  test("shows engine connected indicator when mock engine is running", async ({
    page,
  }) => {
    await page.goto("/");
    const dot = page.getByTestId("engine-status");
    await expect(dot).toBeVisible({ timeout: 10000 });
    await expect(dot).toHaveClass(/bg-green-500/, { timeout: 10000 });
  });
});

test.describe("Fleet management", () => {
  test.beforeEach(async ({ page }) => {
    await resetMockEngine(page);
  });

  test("creates a fleet from the + button", async ({ page }) => {
    await page.goto("/");
    await waitForConnection(page);

    // Click + button in FLEETS section
    const addButton = page
      .locator("button")
      .filter({ has: page.locator("svg.lucide-plus") })
      .first();
    await addButton.click();

    // Should show "Create Fleet" heading
    await expect(
      page.getByRole("heading", { name: "Create Fleet" }),
    ).toBeVisible();

    // Fill in fleet name
    await page.getByPlaceholder("My Project Fleet").fill("Test Fleet Alpha");

    // Add a repo
    await page.getByPlaceholder("owner/repo").fill("test-org/test-repo");
    await page.getByRole("button", { name: "Add" }).click();

    // Repo should appear in the list
    await expect(page.getByText("test-org/test-repo")).toBeVisible();

    // Create the fleet
    await page.getByRole("button", { name: "Create Fleet" }).click();

    // Fleet should appear in sidebar
    const fleetItem = page
      .locator("button")
      .filter({ hasText: "Test Fleet Alpha" });
    await expect(fleetItem).toBeVisible({ timeout: 5000 });
  });

  test("selects a fleet from the sidebar", async ({ page }) => {
    await page.goto("/");
    await waitForConnection(page);

    // Create a fleet
    await createFleet(page, "Select Test Fleet");

    // Click on the fleet in sidebar
    const fleetButton = page
      .locator("button")
      .filter({ hasText: "Select Test Fleet" });
    await fleetButton.click();

    // View switcher should appear (Bridge, Ships, Settings)
    await expect(
      page.getByRole("button", { name: "Bridge", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Ships" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Settings" }),
    ).toBeVisible();
  });
});

test.describe("Bridge", () => {
  test.beforeEach(async ({ page }) => {
    await resetMockEngine(page);
  });

  test("sends a message and receives a response", async ({ page }) => {
    await page.goto("/");
    await waitForConnection(page);

    // Create and select a fleet
    await createAndSelectFleet(page, "Chat Test Fleet");

    // Bridge view should show the input
    const input = page.getByPlaceholder("Send a command to the Bridge...");
    await expect(input).toBeVisible({ timeout: 5000 });

    // Type and send a message
    await input.fill("hello world");
    await input.press("Enter");

    // User message should appear
    await expect(page.getByText("hello world")).toBeVisible();

    // Mock response should appear
    await expect(
      page.getByText("Mock response to: hello world"),
    ).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Ships", () => {
  test.beforeEach(async ({ page }) => {
    await resetMockEngine(page);
  });

  test("shows ships view with sortie button", async ({ page }) => {
    await page.goto("/");
    await waitForConnection(page);

    // Create and select fleet
    await createAndSelectFleet(page, "Ship Test Fleet");

    // Switch to Ships view
    await page.getByRole("button", { name: "Ships" }).click();

    // Should see Sortie button
    await expect(
      page.getByRole("button", { name: /Sortie/i }),
    ).toBeVisible({ timeout: 5000 });
  });
});

// --- Helpers ---

async function waitForConnection(page: Page) {
  const dot = page.getByTestId("engine-status");
  await expect(dot).toHaveClass(/bg-green-500/, { timeout: 10000 });
}

async function createFleet(page: Page, name: string) {
  const addButton = page
    .locator("button")
    .filter({ has: page.locator("svg.lucide-plus") })
    .first();
  await addButton.click();

  // Wait for create form
  await expect(
    page.getByRole("heading", { name: "Create Fleet" }),
  ).toBeVisible({ timeout: 3000 });

  await page.getByPlaceholder("My Project Fleet").fill(name);
  await page.getByRole("button", { name: "Create Fleet" }).click();

  // Wait for fleet to appear in sidebar
  const fleetButton = page.locator("button").filter({ hasText: name });
  await expect(fleetButton).toBeVisible({ timeout: 5000 });
}

async function createAndSelectFleet(page: Page, name: string) {
  await createFleet(page, name);

  // Select the fleet
  const fleetButton = page.locator("button").filter({ hasText: name });
  await fleetButton.click();

  // Wait for view switcher to appear
  const bridgeButton = page.getByRole("button", {
    name: "Bridge",
    exact: true,
  });
  await expect(bridgeButton).toBeVisible({ timeout: 3000 });

  // Switch to Bridge view
  await bridgeButton.click();
}
