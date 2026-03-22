import { test as base, expect, type Page } from "@playwright/test";

export { expect };

export const test = base.extend<{
  enginePort: number;
  vitePort: number;
  admiralHome: string;
}>({
  enginePort: async ({}, use) => {
    const port = parseInt(process.env.E2E_ENGINE_PORT ?? "9721", 10);
    await use(port);
  },
  vitePort: async ({}, use) => {
    const port = parseInt(process.env.E2E_VITE_PORT ?? "1420", 10);
    await use(port);
  },
  admiralHome: async ({}, use) => {
    await use(process.env.E2E_ADMIRAL_HOME ?? "");
  },
  baseURL: async ({ vitePort }, use) => {
    await use(`http://localhost:${vitePort}`);
  },
});

/** Wait for the Engine status indicator to turn green. */
export async function waitForConnection(page: Page) {
  const dot = page.getByTestId("engine-status");
  await expect(dot).toHaveClass(/bg-green-500/, { timeout: 30_000 });
}

/** Create a Fleet via the UI. */
export async function createFleet(
  page: Page,
  name: string,
  repoPath?: string,
) {
  const addButton = page
    .locator("button")
    .filter({ has: page.locator("svg.lucide-plus") })
    .first();
  await addButton.click();

  await expect(
    page.getByRole("heading", { name: "Create Fleet" }),
  ).toBeVisible({ timeout: 5000 });

  await page.getByPlaceholder("My Project Fleet").fill(name);

  if (repoPath) {
    const repoInput = page.getByPlaceholder("/path/to/local/repo");
    await repoInput.fill(repoPath);
    await repoInput.press("Enter");
    await expect(page.getByText(repoPath)).toBeVisible();
  }

  await page.getByRole("button", { name: "Create Fleet" }).click();

  const fleetButton = page.locator("button").filter({ hasText: name });
  await expect(fleetButton).toBeVisible({ timeout: 5000 });
}

/** Create and select a Fleet. */
export async function createAndSelectFleet(
  page: Page,
  name: string,
  repoPath?: string,
) {
  await createFleet(page, name, repoPath);

  const fleetButton = page.locator("button").filter({ hasText: name });
  await fleetButton.click();

  await expect(
    page.getByPlaceholder("Send a command to Flagship..."),
  ).toBeVisible({ timeout: 5000 });
}
