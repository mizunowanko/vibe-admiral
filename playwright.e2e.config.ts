import { defineConfig } from "@playwright/test";

const vitePort = parseInt(process.env.E2E_VITE_PORT ?? "1520", 10);
const enginePort = parseInt(process.env.E2E_ENGINE_PORT ?? "9821", 10);

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: `http://localhost:${vitePort}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `npm run dev:frontend`,
    url: `http://localhost:${vitePort}`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      VITE_PORT: String(vitePort),
      VITE_ENGINE_PORT: String(enginePort),
    },
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
