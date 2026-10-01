import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import type { LocalStore } from "../persistence/LocalStore";
import { openSecret, sealSecret } from "../secrets/vault";
export type SshCredentialScope = "session" | "mission" | "reusable";

export interface SshHostConfig {
  alias: string;
  host: string;
  user: string;
  port?: number;
  keyPath?: string;
  scope?: SshCredentialScope;
  vaultKeyName?: string;
}

export function sshConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".orvyn", "ssh.json");
}

const sessionHosts = new Map<string, SshHostConfig[]>();
const missionHosts = new Map<string, SshHostConfig[]>();

export function parseSshTarget(raw: string): { host: string; port?: number } | null {
  const t = String(raw ?? "").trim();
  if (!t || /[\s;|&$`'"]/.test(t)) return null;
  if (t.length > 253) return null;
  const withPort = t.match(/^([^[\]]+):(\d{1,5})$/);
  if (withPort) {
    const port = Number(withPort[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    if (!isHost(withPort[1])) return null;
    return { host: withPort[1], port };
  }
  if (!isHost(t)) return null;
  return { host: t };
}

function isHost(value: string): boolean {
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    return value.split(".").every((octet) => {
      const n = Number(octet);
      return n >= 0 && n <= 255;
    });
  }
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(value);
}

export function vaultNameFor(alias: string): string {
  return `ssh.key.${alias.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80)}`;
}

function remember(map: Map<string, SshHostConfig[]>, key: string, host: SshHostConfig): void {
  const list = map.get(key) ?? [];
  const next = list.filter((h) => h.alias !== host.alias);
  next.push(host);
  map.set(key, next);
}

export function rememberSessionHost(tenantId: string, host: SshHostConfig): void {
  remember(sessionHosts, tenantId, { ...host, scope: "session" });
}

export function rememberMissionHost(tenantId: string, runId: string, host: SshHostConfig): void {
  remember(missionHosts, `${tenantId}:${runId}`, { ...host, scope: "mission" });
}

export function ephemeralHosts(tenantId: string, runId?: string): SshHostConfig[] {
  const out = [...(sessionHosts.get(tenantId) ?? [])];
  if (runId) out.push(...(missionHosts.get(`${tenantId}:${runId}`) ?? []));
  else {
    for (const [key, hosts] of missionHosts) {
      if (key.startsWith(`${tenantId}:`)) out.push(...hosts);
    }
  }
  return out;
}

export async function readFileHosts(projectRoot: string): Promise<SshHostConfig[]> {
  try {
    const raw = await fs.readFile(sshConfigPath(projectRoot), "utf-8");
    const parsed = JSON.parse(raw) as { hosts?: SshHostConfig[] };
    if (!Array.isArray(parsed.hosts)) return [];
    return parsed.hosts.filter((h) => h && h.alias && h.host && h.user);
  } catch {
    return [];
  }
}

export async function writeFileHosts(projectRoot: string, hosts: SshHostConfig[]): Promise<void> {
  const file = sshConfigPath(projectRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ hosts }, null, 2), "utf-8");
}

export async function listResolvedHosts(opts: {
  projectRoot?: string | null;
  tenantId: string;
  runId?: string;
}): Promise<SshHostConfig[]> {
  const file = opts.projectRoot ? await readFileHosts(opts.projectRoot) : [];
  const extra = ephemeralHosts(opts.tenantId, opts.runId);
  const byAlias = new Map<string, SshHostConfig>();
  for (const h of [...file, ...extra]) byAlias.set(h.alias, h);
  return [...byAlias.values()];
}

export async function upsertSshHost(opts: {
  tenantId: string;
  localStore: LocalStore;
  projectRoot?: string | null;
  runId?: string;
  alias: string;
  host: string;
  user: string;
  port?: number;
  keyPath?: string;
  privateKey?: string;
  scope: SshCredentialScope;
}): Promise<SshHostConfig> {
  const parsed = parseSshTarget(opts.host);
  if (!parsed) throw new Error("Enter a hostname or IP (optionally host:port).");
  const alias = opts.alias.trim() || parsed.host.replace(/[^\w.-]+/g, "-").slice(0, 40);
  if (!alias) throw new Error("Alias is required.");
  const user = opts.user.trim();
  if (!user) throw new Error("SSH user is required.");
  const host: SshHostConfig = {
    alias,
    host: parsed.host,
    user,
    port: opts.port ?? parsed.port ?? 22,
    keyPath: opts.keyPath?.trim() || undefined,
    scope: opts.scope,
  };
  const keyMaterial = opts.privateKey?.trim();
  if (keyMaterial) {
    const name = vaultNameFor(alias);
    opts.localStore.setSetting(name, sealSecret(keyMaterial, opts.tenantId, name));
    host.vaultKeyName = name;
  }
  if (opts.scope === "session") rememberSessionHost(opts.tenantId, host);
  else if (opts.scope === "mission") {
    if (!opts.runId) throw new Error("Mission-scoped credentials need an active run.");
    rememberMissionHost(opts.tenantId, opts.runId, host);
  } else if (opts.projectRoot) {
    const existing = await readFileHosts(opts.projectRoot);
    const next = existing.filter((h) => h.alias !== alias);
    next.push({ ...host, scope: "reusable" });
    await writeFileHosts(opts.projectRoot, next);
  } else {
    rememberSessionHost(opts.tenantId, host);
  }
  return host;
}

export async function materializeIdentity(opts: {
  tenantId: string;
  localStore: LocalStore;
  host: SshHostConfig;
}): Promise<{ keyPath?: string; cleanup: () => Promise<void> }> {
  if (opts.host.keyPath) return { keyPath: opts.host.keyPath, cleanup: async () => undefined };
  const name = opts.host.vaultKeyName;
  if (!name) return { cleanup: async () => undefined };
  const sealed = opts.localStore.getSetting(name);
  if (!sealed) return { cleanup: async () => undefined };
  const key = openSecret(sealed, opts.tenantId, name);
  if (!key) return { cleanup: async () => undefined };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-ssh-"));
  const file = path.join(dir, "id");
  await fs.writeFile(file, key.endsWith("\n") ? key : `${key}\n`, { encoding: "utf-8", mode: 0o600 });
  return {
    keyPath: file,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
