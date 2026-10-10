import type { CapacitorConfig } from "@capacitor/cli";

/** Bundle the UI locally; the cloud origin is selected when building with Vite. */
const config: CapacitorConfig = {
  appId: "com.orvyn.mobile",
  appName: "ORVYN",
  webDir: "dist",
  server: { androidScheme: "https" },
};
export default config;
