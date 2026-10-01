import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { defaultDataDir } from "../persistence/LocalStore";

export const RELEASE_CHANNELS = ["stable", "beta", "canary"] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];
export const RELEASE_STATUSES = ["draft", "published", "paused", "superseded"] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

export const TELEMETRY_EVENTS = [
  "app_started",
  "update_check",
  "update_available",
  "update_download_started",
  "update_downloaded",
  "update_install_requested",
  "update_success",
  "update_error",
] as const;
export type TelemetryEvent = (typeof TELEMETRY_EVENTS)[number];

export interface ReleaseArtifact {
  platform: "win32" | "darwin" | "linux";
  filename: string;
  url: string;
  size?: number;
}

export interface DesktopRelease {
  id: string;
  version: string;
  channel: ReleaseChannel;
  title: string;
  notes: string;
  publishedAt: number | null;
  required: boolean;
  minimumSupportedVersion: string | null;
  rolloutPercent: number;
  status: ReleaseStatus;
  artifacts: ReleaseArtifact[];
  gitSha: string | null;
}

export interface CurrentRelease {
  latest: string | null;
  minimumSupported: string | null;
  channel: ReleaseChannel;
  required: boolean;
  notes: string | null;
  publishedAt: string | null;
  rolloutPercent: number;
  paused: boolean;
  title: string | null;
}

function parseChannel(raw: unknown): ReleaseChannel | null {
  const v = String(raw ?? "").trim().toLowerCase();
  return RELEASE_CHANNELS.includes(v as ReleaseChannel) ? (v as ReleaseChannel) : null;
}

function parseStatus(raw: unknown): ReleaseStatus | null {
  const v = String(raw ?? "").trim().toLowerCase();
  return RELEASE_STATUSES.includes(v as ReleaseStatus) ? (v as ReleaseStatus) : null;
}

function sanitizeNotes(raw: unknown): string {
  return String(raw ?? "")
    .replace(/<[^>]*>/g, "")
    .slice(0, 8000);
}

function rowToRelease(row: Record<string, unknown>): DesktopRelease {
  let artifacts: ReleaseArtifact[] = [];
  try {
    artifacts = JSON.parse(String(row.artifacts || "[]")) as ReleaseArtifact[];
  } catch {
    artifacts = [];
  }
  return {
    id: String(row.id),
    version: String(row.version),
    channel: row.channel as ReleaseChannel,
    title: String(row.title ?? ""),
    notes: String(row.notes ?? ""),
    publishedAt: row.published_at == null ? null : Number(row.published_at),
    required: Number(row.required) === 1,
    minimumSupportedVersion: row.minimum_supported ? String(row.minimum_supported) : null,
    rolloutPercent: Number(row.rollout_percent ?? 100),
    status: row.status as ReleaseStatus,
    artifacts,
    gitSha: row.git_sha ? String(row.git_sha) : null,
  };
}

export class DesktopReleaseStore {
  readonly db: DatabaseSync;

  constructor(dataDir: string = defaultDataDir()) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "desktop-releases.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS desktop_releases (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        channel TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        published_at INTEGER,
        required INTEGER NOT NULL DEFAULT 0,
        minimum_supported TEXT,
        rollout_percent INTEGER NOT NULL DEFAULT 100,
        status TEXT NOT NULL DEFAULT 'draft',
        artifacts TEXT NOT NULL DEFAULT '[]',
        git_sha TEXT,
        UNIQUE(channel, version)
      );
      CREATE TABLE IF NOT EXISTS desktop_installations (
        installation_id TEXT PRIMARY KEY,
        account_id TEXT,
        platform TEXT NOT NULL,
        arch TEXT NOT NULL,
        version TEXT NOT NULL,
        channel TEXT NOT NULL,
        last_event TEXT,
        last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS desktop_update_events (
        id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        event TEXT NOT NULL,
        version TEXT NOT NULL,
        channel TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS desktop_events_at ON desktop_update_events (at);
    `);
  }

  list(): DesktopRelease[] {
    const rows = this.db.prepare("SELECT * FROM desktop_releases ORDER BY published_at DESC, version DESC").all() as Record<string, unknown>[];
    return rows.map(rowToRelease);
  }

  get(id: string): DesktopRelease | null {
    const row = this.db.prepare("SELECT * FROM desktop_releases WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToRelease(row) : null;
  }

  upsertFromPipeline(input: {
    version: string;
    channel: unknown;
    title?: string;
    notes?: string;
    artifacts?: ReleaseArtifact[];
    gitSha?: string;
    status?: unknown;
  }): DesktopRelease {
    const channel = parseChannel(input.channel);
    if (!channel) throw Object.assign(new Error("Invalid channel."), { status: 400 });
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.version)) {
      throw Object.assign(new Error("Invalid version."), { status: 400 });
    }
    const existing = this.db.prepare("SELECT id FROM desktop_releases WHERE channel = ? AND version = ?").get(channel, input.version) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    const status = parseStatus(input.status) ?? "published";
    const publishedAt = status === "published" ? Date.now() : null;
    this.db.prepare(`
      INSERT INTO desktop_releases (id, version, channel, title, notes, published_at, required, minimum_supported, rollout_percent, status, artifacts, git_sha)
      VALUES (?, ?, ?, ?, ?, ?, 0, NULL, 100, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, notes=excluded.notes, artifacts=excluded.artifacts, git_sha=excluded.git_sha, status=excluded.status, published_at=COALESCE(desktop_releases.published_at, excluded.published_at)
    `).run(id, input.version, channel, String(input.title ?? `ORVYN ${input.version}`), sanitizeNotes(input.notes), publishedAt, status, JSON.stringify(input.artifacts ?? []), input.gitSha ?? null);
    return this.get(id)!;
  }

  patch(id: string, patch: {
    notes?: unknown;
    title?: unknown;
    rolloutPercent?: unknown;
    status?: unknown;
    required?: unknown;
    minimumSupportedVersion?: unknown;
    allowRequired?: boolean;
  }): DesktopRelease {
    const cur = this.get(id);
    if (!cur) throw Object.assign(new Error("No such release."), { status: 404 });
    let required = cur.required;
    let minimum = cur.minimumSupportedVersion;
    if (patch.required !== undefined || patch.minimumSupportedVersion !== undefined) {
      if (!patch.allowRequired) throw Object.assign(new Error("Marking a required update needs a super admin."), { status: 403 });
      if (patch.required !== undefined) required = patch.required === true;
      if (patch.minimumSupportedVersion !== undefined) {
        const v = String(patch.minimumSupportedVersion ?? "").trim();
        minimum = v || null;
      }
    }
    const status = patch.status !== undefined ? parseStatus(patch.status) : cur.status;
    if (patch.status !== undefined && !status) throw Object.assign(new Error("Invalid status."), { status: 400 });
    let rollout = cur.rolloutPercent;
    if (patch.rolloutPercent !== undefined) {
      const n = Math.floor(Number(patch.rolloutPercent));
      if (![5, 10, 25, 50, 100, 0].includes(n)) throw Object.assign(new Error("Rollout must be 0, 5, 10, 25, 50, or 100."), { status: 400 });
      rollout = n;
    }
    const notes = patch.notes !== undefined ? sanitizeNotes(patch.notes) : cur.notes;
    const title = patch.title !== undefined ? String(patch.title ?? "").slice(0, 200) : cur.title;
    const publishedAt = status === "published" && !cur.publishedAt ? Date.now() : cur.publishedAt;
    this.db.prepare(`
      UPDATE desktop_releases SET notes=?, title=?, rollout_percent=?, status=?, required=?, minimum_supported=?, published_at=?
      WHERE id=?
    `).run(notes, title, rollout, status, required ? 1 : 0, minimum, publishedAt, id);
    return this.get(id)!;
  }

  current(channelRaw: unknown): CurrentRelease {
    const channel = parseChannel(channelRaw) ?? "stable";
    const row = this.db.prepare(`
      SELECT * FROM desktop_releases
      WHERE channel = ? AND status = 'published'
      ORDER BY published_at DESC
      LIMIT 1
    `).get(channel) as Record<string, unknown> | undefined;
    const envMin = process.env.ORVYN_DESKTOP_MINIMUM_SUPPORTED?.trim() || null;
    if (!row) {
      const envLatest = process.env.ORVYN_DESKTOP_VERSION?.trim() || null;
      return {
        latest: envLatest,
        minimumSupported: envMin,
        channel,
        required: Boolean(envMin && envLatest),
        notes: null,
        publishedAt: null,
        rolloutPercent: 100,
        paused: false,
        title: envLatest ? `ORVYN ${envLatest}` : null,
      };
    }
    const rel = rowToRelease(row);
    return {
      latest: rel.version,
      minimumSupported: rel.minimumSupportedVersion ?? envMin,
      channel,
      required: rel.required,
      notes: rel.notes || null,
      publishedAt: rel.publishedAt ? new Date(rel.publishedAt).toISOString() : null,
      rolloutPercent: rel.rolloutPercent,
      paused: false,
      title: rel.title || null,
    };
  }

  summary(): { channels: Record<ReleaseChannel, string | null>; adoption: { version: string; count: number; percent: number }[]; releases: DesktopRelease[]; failures: number } {
    const channels = { stable: null, beta: null, canary: null } as Record<ReleaseChannel, string | null>;
    for (const ch of RELEASE_CHANNELS) channels[ch] = this.current(ch).latest;
    const rows = this.db.prepare("SELECT version, COUNT(*) AS n FROM desktop_installations GROUP BY version ORDER BY n DESC").all() as { version: string; n: number }[];
    const total = rows.reduce((s, r) => s + Number(r.n), 0) || 1;
    const adoption = rows.map((r) => ({ version: r.version, count: Number(r.n), percent: Math.round((Number(r.n) / total) * 100) }));
    const failures = Number((this.db.prepare("SELECT COUNT(*) AS n FROM desktop_update_events WHERE event = 'update_error'").get() as { n: number }).n);
    return { channels, adoption, releases: this.list(), failures };
  }

  recordTelemetry(input: {
    installationId: unknown;
    accountId?: string;
    platform: unknown;
    arch: unknown;
    version: unknown;
    channel: unknown;
    event: unknown;
  }): void {
    const installationId = String(input.installationId ?? "").trim();
    if (installationId.length < 8 || installationId.length > 80) return;
    const event = String(input.event ?? "");
    if (!TELEMETRY_EVENTS.includes(event as TelemetryEvent)) return;
    const channel = parseChannel(input.channel) ?? "stable";
    const platform = ["win32", "darwin", "linux"].includes(String(input.platform)) ? String(input.platform) : "win32";
    const arch = String(input.arch ?? "x64").slice(0, 16);
    const version = String(input.version ?? "").slice(0, 40);
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO desktop_installations (installation_id, account_id, platform, arch, version, channel, last_event, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(installation_id) DO UPDATE SET
        account_id=COALESCE(excluded.account_id, desktop_installations.account_id),
        platform=excluded.platform, arch=excluded.arch, version=excluded.version, channel=excluded.channel,
        last_event=excluded.last_event, last_seen=excluded.last_seen
    `).run(installationId, input.accountId ?? null, platform, arch, version, channel, event, now);
    this.db.prepare("INSERT INTO desktop_update_events (id, installation_id, event, version, channel, at) VALUES (?, ?, ?, ?, ?, ?)").run(randomUUID(), installationId, event, version, channel, now);
  }

  installationsForAccount(accountId: string): { installationId: string; platform: string; version: string; channel: string; lastSeen: number }[] {
    const rows = this.db.prepare("SELECT installation_id, platform, version, channel, last_seen FROM desktop_installations WHERE account_id = ? ORDER BY last_seen DESC LIMIT 20").all(accountId) as Record<string, unknown>[];
    return rows.map((r) => ({
      installationId: String(r.installation_id),
      platform: String(r.platform),
      version: String(r.version),
      channel: String(r.channel),
      lastSeen: Number(r.last_seen),
    }));
  }

  publicDownloads(): { windows: string | null; mac: string | null; linux: string | null; version: string | null; notes: string | null } {
    const env = (k: string) => process.env[k]?.trim() || null;
    const current = this.current("stable");
    const base = (process.env.ORVYN_UPDATE_BASE_URL || "https://updates.kernelailabs.com/orvyn").replace(/\/+$/, "");
    const rel = this.list().find((r) => r.channel === "stable" && r.status === "published" && r.version === current.latest);
    const urlFor = (platform: ReleaseArtifact["platform"], envKey: string, fallbackName: string) => {
      const fromEnv = env(envKey);
      if (fromEnv) return fromEnv;
      const artifact = rel?.artifacts.find((a) => a.platform === platform);
      if (artifact?.url) return artifact.url;
      if (current.latest) return `${base}/stable/${fallbackName.replace("{version}", current.latest)}`;
      return null;
    };
    return {
      windows: urlFor("win32", "ORVYN_DESKTOP_DOWNLOAD_WINDOWS", "ORVYN-Setup-{version}.exe"),
      mac: urlFor("darwin", "ORVYN_DESKTOP_DOWNLOAD_MAC", "ORVYN-{version}-mac.zip"),
      linux: urlFor("linux", "ORVYN_DESKTOP_DOWNLOAD_LINUX", "ORVYN-{version}.AppImage"),
      version: current.latest || env("ORVYN_DESKTOP_VERSION"),
      notes: current.notes,
    };
  }
}

let instance: DesktopReleaseStore | null = null;
export function desktopReleaseStore(): DesktopReleaseStore {
  if (!instance) instance = new DesktopReleaseStore();
  return instance;
}
