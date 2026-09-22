import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import * as path from "path";
import { execSync } from "child_process";

function resolveBuildSha(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  if (process.env.ORVYN_BUILD_SHA) return process.env.ORVYN_BUILD_SHA;
  try {
    return execSync("git rev-parse HEAD", { cwd: path.resolve(__dirname, "../.."), stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "dev";
  }
}

export default defineConfig({
  root: path.resolve(__dirname, "src/renderer"),
  plugins: [react()],
  base: "./",
  worker: { format: "es" },
  define: {
    __ORVYN_BUILD_SHA__: JSON.stringify(resolveBuildSha()),
  },
  build: {
    outDir: path.resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
  },
});
