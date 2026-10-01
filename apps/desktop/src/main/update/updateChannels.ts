export const UPDATE_CHANNELS = ["stable", "beta", "canary"] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export const DEFAULT_UPDATE_BASE_URL = "https://updates.kernelailabs.com/orvyn";

export function parseUpdateChannel(raw: unknown): UpdateChannel | null {
  const v = String(raw ?? "").trim().toLowerCase();
  return UPDATE_CHANNELS.includes(v as UpdateChannel) ? (v as UpdateChannel) : null;
}

export function updateBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = String(env.ORVYN_UPDATE_BASE_URL ?? DEFAULT_UPDATE_BASE_URL).trim().replace(/\/+$/, "");
  if (!raw || /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(raw)) return DEFAULT_UPDATE_BASE_URL;
  return raw;
}

export function latestManifestName(platform: NodeJS.Platform | string = process.platform): string {
  if (platform === "darwin") return "latest-mac.yml";
  if (platform === "linux") return "latest-linux.yml";
  return "latest.yml";
}

export function feedUrlForChannel(channel: UpdateChannel, env?: NodeJS.ProcessEnv): string {
  return `${updateBaseUrl(env)}/${channel}/`;
}

/** Stable feeds never advertise prerelease versions. */
export function versionMatchesChannel(version: string, channel: UpdateChannel): boolean {
  const v = String(version ?? "").trim();
  const pre = v.split("-")[1]?.toLowerCase() ?? "";
  if (channel === "stable") return !pre;
  if (channel === "beta") return !pre || pre.startsWith("beta");
  return true;
}
