// apps/backend/src/mcp/McpRegistry.ts
//
// Persistent MCP server configuration + secrets. Config lives in the
// tenant's LocalStore (SQLite); secrets live under a SEPARATE namespace so
// no credential ever sits inside a server-config record, log line, or API
// response. The store is the seam a future OS-keychain/Electron
// safeStorage backend plugs into.

import { openSecret, sealSecret } from "../secrets/vault";
import type { McpPermissionPolicy, McpServerConfig } from "./McpTypes";

const CONFIG_KEY = "mcp.servers.v1";
const POLICY_KEY = "mcp.policies.v1";
const SECRET_PREFIX = "mcp.secret.";

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** LocalStore-backed secret storage — the credential seam. */
export function makeSecretStore(
  store: { getSetting(k: string): unknown; setSetting(k: string, v: string): void; deleteSetting?(k: string): void },
  tenantId: string,
): SecretStore {
  return {
    get: async (k) => {
      const name = SECRET_PREFIX + k;
      const v = await store.getSetting(name);
      if (typeof v !== "string" || !v) return null;
      return openSecret(v, tenantId, name);
    },
    set: async (k, v) => {
      const name = SECRET_PREFIX + k;
      await store.setSetting(name, sealSecret(v, tenantId, name));
    },
    delete: async (k) => {
      const name = SECRET_PREFIX + k;
      if (store.deleteSetting) await store.deleteSetting(name);
      else await store.setSetting(name, "");
    },
  };
}

export class McpRegistry {
  private configs = new Map<string, McpServerConfig>();
  private policies = new Map<string, McpPermissionPolicy>();
  private secrets: SecretStore;

  constructor(
    store: { getSetting(k: string): unknown; setSetting(k: string, v: string): void; deleteSetting?(k: string): void },
    tenantId = "local",
  ) {
    this.secrets = makeSecretStore(store, tenantId);
    try {
      const raw = store.getSetting(CONFIG_KEY);
      const list = raw ? (JSON.parse(String(raw)) as McpServerConfig[]) : [];
      for (const c of list) this.configs.set(c.id, c);
    } catch {
      /* corrupt config — start empty, never crash the app for it */
    }
    try {
      const raw = store.getSetting(POLICY_KEY);
      const obj = raw ? (JSON.parse(String(raw)) as Record<string, McpPermissionPolicy>) : {};
      for (const [id, p] of Object.entries(obj)) this.policies.set(id, p);
    } catch {
      /* same */
    }
  }

  private persist(store: { setSetting(k: string, v: string): void }): void {
    // Secrets are filtered out defensively: config records never carry them.
    const safe = [...this.configs.values()].map((c) => ({ ...c, headers: c.headers ? this.stripSecretValues(c.headers, c.headers) : undefined }));
    store.setSetting(CONFIG_KEY, JSON.stringify(safe));
    store.setSetting(POLICY_KEY, JSON.stringify(Object.fromEntries(this.policies)));
  }

  private stripSecretValues(headers: Record<string, string>, keep: Record<string, string>): Record<string, string> {
    // Header values that reference a secret name are replaced with a
    // reference token; the live value is pulled from the secret store at
    // connect time.
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      out[k] = v.startsWith("secret:") ? `{{${v.slice(7)}}}` : keep[k];
    }
    return out;
  }

  list(): McpServerConfig[] {
    return [...this.configs.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): McpServerConfig | undefined {
    return this.configs.get(id);
  }

  upsert(cfg: McpServerConfig, store: { setSetting(k: string, v: string): void }): McpServerConfig {
    this.configs.set(cfg.id, cfg);
    this.persist(store);
    return cfg;
  }

  async remove(id: string, store: { setSetting(k: string, v: string): void }): Promise<void> {
    // Best-effort secret cleanup when the server goes away.
    const cfg = this.configs.get(id);
    for (const s of cfg?.secretNames ?? []) await this.secrets.delete(`${id}.${s}`);
    this.configs.delete(id);
    this.policies.delete(id);
    this.persist(store);
  }

  policy(id: string): McpPermissionPolicy {
    return this.policies.get(id) ?? { serverDefaults: {}, toolOverrides: {} };
  }

  setPolicy(id: string, policy: McpPermissionPolicy, store: { setSetting(k: string, v: string): void }): void {
    this.policies.set(id, policy);
    this.persist(store);
  }

  async secret(id: string, name: string): Promise<string | null> {
    return this.secrets.get(`${id}.${name}`);
  }

  async setSecret(id: string, name: string, value: string): Promise<void> {
    await this.secrets.set(`${id}.${name}`, value);
  }

  async deleteSecret(id: string, name: string): Promise<void> {
    await this.secrets.delete(`${id}.${name}`);
  }

  /** Resolves {{secretName}} header references at connect time. */
  async resolveHeaders(id: string, headers: Record<string, string> | undefined): Promise<Record<string, string>> {
    if (!headers) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      // Substring replacement: "Bearer {{token}}" keeps its scheme prefix.
      const replacements = new Map<string, string>();
      for (const match of v.matchAll(/\{\{([^}]+)\}\}/g)) {
        if (!replacements.has(match[1])) replacements.set(match[1], await this.secrets.get(`${id}.${match[1]}`) ?? "");
      }
      out[k] = v.replace(/\{\{([^}]+)\}\}/g, (_all, name: string) => replacements.get(name) ?? "");
    }
    return out;
  }

  /** Injects stored secrets into the stdio process environment at connect time. */
  async resolveEnv(id: string, env: Record<string, string> | undefined): Promise<Record<string, string>> {
    const cfg = this.configs.get(id);
    const out: Record<string, string> = { ...(env ?? {}) };
    for (const name of cfg?.secretNames ?? []) {
      const value = await this.secrets.get(`${id}.${name}`);
      if (!value) continue;
      out[name] = value;
      const github = /github/i.test(`${cfg?.name ?? ""} ${cfg?.marketplaceId ?? ""} ${cfg?.packageIdentifier ?? ""}`);
      if (github && /^(token|TOKEN|authorization)$/i.test(name) && !out.GITHUB_PERSONAL_ACCESS_TOKEN) {
        out.GITHUB_PERSONAL_ACCESS_TOKEN = value.replace(/^Bearer\s+/i, "");
      }
    }
    return out;
  }
}
