import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    projects: [
      {
        test: {
          name: "frontend",
          environment: "jsdom",
          globals: true,
          setupFiles: ["./src/test-utils/setup.ts"],
          include: ["src/**/*.test.{ts,tsx}"],
        },
        resolve: {
          alias: {
            "@": path.resolve(__dirname, "./src"),
          },
        },
      },
      "./engine/vitest.config.ts",
    ],
  },
});
