import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./ui-test",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  globalSetup: "./ui-test/global-setup.ts",
  globalTeardown: "./ui-test/global-teardown.ts",
  use: {
    baseURL: "http://localhost:1420",
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run dev:frontend",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
