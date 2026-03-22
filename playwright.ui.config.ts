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
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
