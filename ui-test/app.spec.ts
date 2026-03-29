import { test, expect, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const MOCK_ENGINE_PORT = parseInt(
  process.env.UI_TEST_ENGINE_PORT ?? "19721",
  10,
);
const BASE_URL = `http://localhost:${process.env.UI_TEST_VITE_PORT ?? "1420"}`;

/**
 * Reset mock engine state via a special WebSocket message.
 * This ensures test isolation by clearing accumulated fleets.
 */
async function resetMockEngine(page: Page) {
  const port = MOCK_ENGINE_PORT;
  await page.evaluate((p) => {
    const ws = new WebSocket(`ws://localhost:${p}`);
    return new Promise<void>((resolve) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "__test:reset" }));
        ws.close();
        resolve();
      };
      ws.onerror = () => resolve();
    });
  }, port);
}

test.describe("Connection", () => {
  test("shows engine connected indicator when mock engine is running", async ({
    page,
  }) => {
    await page.goto(BASE_URL);
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
    await page.goto(BASE_URL);
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

    // Add a repo (press Enter to confirm the path)
    const repoInput = page.getByPlaceholder("/path/to/local/repo");
    await repoInput.fill("/tmp/test-repo");
    await repoInput.press("Enter");

    // Repo should appear in the list
    await expect(page.getByText("/tmp/test-repo")).toBeVisible();

    // Create the fleet
    await page.getByRole("button", { name: "Create Fleet" }).click();

    // Fleet should appear in sidebar
    const fleetItem = page
      .locator("button")
      .filter({ hasText: "Test Fleet Alpha" });
    await expect(fleetItem).toBeVisible({ timeout: 5000 });
  });

  test("selects a fleet from the sidebar", async ({ page }) => {
    await page.goto(BASE_URL);
    await waitForConnection(page);

    // Create a fleet
    await createFleet(page, "Select Test Fleet");

    // Click on the fleet in sidebar
    const fleetButton = page
      .locator("button")
      .filter({ hasText: "Select Test Fleet" });
    await fleetButton.click();

    // Command view should appear with Flagship chat input
    await expect(
      page.getByPlaceholder("Send a command to Flagship..."),
    ).toBeVisible({ timeout: 5000 });

    // Settings button should appear in sidebar
    await expect(
      page.getByRole("button", { name: "Fleet Settings", exact: true }),
    ).toBeVisible();
  });
});

test.describe("Commander (Flagship)", () => {
  test.beforeEach(async ({ page }) => {
    await resetMockEngine(page);
  });

  test("sends a message and receives a response", async ({ page }) => {
    await page.goto(BASE_URL);
    await waitForConnection(page);

    // Create and select a fleet
    await createAndSelectFleet(page, "Chat Test Fleet");

    // Flagship view should show the input
    const input = page.getByPlaceholder("Send a command to Flagship...");
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

test.describe("Fleet settings", () => {
  test.beforeEach(async ({ page }) => {
    await resetMockEngine(page);
  });

  test("opens settings view from sidebar", async ({ page }) => {
    await page.goto(BASE_URL);
    await waitForConnection(page);

    // Create and select fleet
    await createAndSelectFleet(page, "Config Test Fleet");

    // Click Settings button in sidebar
    await page
      .getByRole("button", { name: "Settings", exact: true })
      .click();

    // Fleet settings should show the fleet name
    await expect(page.getByText("Config Test Fleet")).toBeVisible({
      timeout: 5000,
    });
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

  // Wait for Command view to appear (fleet selection auto-navigates to command)
  await expect(
    page.getByPlaceholder("Send a command to Flagship..."),
  ).toBeVisible({ timeout: 5000 });
}
