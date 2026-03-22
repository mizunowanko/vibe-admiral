import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const vitePort = parseInt(process.env.VITE_PORT ?? "1420", 10);
const enginePort = parseInt(process.env.VITE_ENGINE_PORT ?? "9721", 10);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: vitePort,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://localhost:${enginePort}`,
        changeOrigin: true,
      },
    },
  },
});
