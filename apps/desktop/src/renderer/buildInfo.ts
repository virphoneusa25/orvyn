// Injected at Vite build time. Packaged Electron does not pull git — this SHA
// is how you tell which desktop build is actually running.

declare const __ORVYN_BUILD_SHA__: string | undefined;

export const DESKTOP_BUILD_SHA =
  typeof __ORVYN_BUILD_SHA__ === "string" && __ORVYN_BUILD_SHA__.length > 0 ? __ORVYN_BUILD_SHA__ : "dev";

export function shortBuildSha(sha = DESKTOP_BUILD_SHA): string {
  return sha === "dev" ? "dev" : sha.slice(0, 7);
}
