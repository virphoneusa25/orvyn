import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import * as path from "path";

// ORVYN Cloud portal. Built into dist/ and served by the backend at "/" on the
// same origin as the API (no CORS, no tokens in URLs).
export default defineConfig({
  root: path.resolve(__dirname, "src"),
  plugins: [react()],
  base: "/",
  publicDir: path.resolve(__dirname, "public"),
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
  server: {
    port: 5180,
    proxy: {
      "/api": "http://localhost:4570",
      "/ws": { target: "ws://localhost:4570", ws: true },
    },
  },
});
