import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import { parseUpdateChannel, type UpdateChannel } from "./updateChannels";

export interface UpdatePrefs {
  channel: UpdateChannel;
  autoCheck: boolean;
  autoDownload: boolean;
  installOnExit: boolean;
  installationId: string;
}

const DEFAULTS: UpdatePrefs = {
  channel: "stable",
  autoCheck: true,
  autoDownload: false,
  installOnExit: true,
  installationId: "",
};

export function prefsPath(userData: string): string {
  return path.join(userData, "orvyn-update-prefs.json");
}

export function normalizePrefs(raw: unknown): UpdatePrefs {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const channel = parseUpdateChannel(o.channel) ?? "stable";
  const installationId = typeof o.installationId === "string" && o.installationId.length >= 8 ? o.installationId : randomUUID();
  return {
    channel,
    autoCheck: o.autoCheck !== false,
    autoDownload: o.autoDownload === true,
    installOnExit: o.installOnExit !== false,
    installationId,
  };
}

export async function loadUpdatePrefs(userData: string): Promise<UpdatePrefs> {
  try {
    const text = await fs.readFile(prefsPath(userData), "utf8");
    return normalizePrefs(JSON.parse(text));
  } catch {
    const prefs = normalizePrefs(DEFAULTS);
    await saveUpdatePrefs(userData, prefs);
    return prefs;
  }
}

export async function saveUpdatePrefs(userData: string, prefs: UpdatePrefs): Promise<void> {
  const next = normalizePrefs(prefs);
  await fs.mkdir(userData, { recursive: true });
  await fs.writeFile(prefsPath(userData), JSON.stringify(next, null, 2), "utf8");
}
