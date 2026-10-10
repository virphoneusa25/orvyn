import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { validatedMobileOrigin } from "../../web/src/lib/mobilePlatform";

const here = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, here, "");
  // This is a public service address, never a provider secret.
  const origin = validatedMobileOrigin(process.env.ORVYN_MOBILE_API_ORIGIN || env.ORVYN_MOBILE_API_ORIGIN || "https://app.kernelailabs.com");
  return {
    root: here,
    plugins: [react()],
    base: "./",
    publicDir: fileURLToPath(new URL("../../web/public", import.meta.url)),
    define: { __ORVYN_API_ORIGIN__: JSON.stringify(origin) },
    build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  };
});
