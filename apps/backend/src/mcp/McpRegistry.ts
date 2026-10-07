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


  readonly ready: Promise<void>;
  private initialized = false;
  private writes: Promise<void> = Promise.resolve();
  constructor(store: { getSetting(k: string): unknown; setSetting(k: string, v: string): void | Promise<void>; deleteSetting?(k: string): void | Promise<void> }, tenantId = "local") {
    this.secrets = makeSecretStore(store, tenantId);
    const values = [store.getSetting("mcp.registry.v2"), store.getSetting(CONFIG_KEY), store.getSetting(POLICY_KEY)];
    if (values.some((value) => value instanceof Promise)) this.ready = Promise.all(values).then((rows) => this.hydrate(rows));
    else { this.hydrate(values); this.ready = Promise.resolve(); }
    void this.ready.catch(() => {});
  }
  private hydrate([document, configs, policies]: unknown[]): void {
    if (document) {
      const parsed = JSON.parse(String(document));
      if (parsed.version !== 2 || !Array.isArray(parsed.configs) || !parsed.policies || typeof parsed.policies !== "object" || Array.isArray(parsed.policies)) throw new Error("Invalid MCP registry storage");
      this.configs = new Map(parsed.configs.map((c: McpServerConfig) => [c.id, c]));
      this.policies = new Map(Object.entries(parsed.policies));
    } else {
      try { for (const c of configs ? JSON.parse(String(configs)) : []) this.configs.set(c.id, c); } catch {}
      try { for (const [id, policy] of Object.entries(policies ? JSON.parse(String(policies)) : {})) this.policies.set(id, policy as McpPermissionPolicy); } catch {}
    }
    this.initialized = true;
  }
  private requireReady(): void { if (!this.initialized) throw new Error("MCP registry initialization is incomplete"); }
  private change<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(async () => { await this.ready; return operation(); });
    this.writes = result.then(() => {}, () => {});
    return result;
  }
  private async persist(store: { setSetting(k: string, v: string): void | Promise<void> }, configs: Map<string, McpServerConfig>, policies: Map<string, McpPermissionPolicy>): Promise<void> {
    const safe = [...configs.values()].map((c) => ({ ...c, headers: c.headers ? this.stripSecretValues(c.headers, c.headers) : undefined }));
    await store.setSetting("mcp.registry.v2", JSON.stringify({ version: 2, configs: safe, policies: Object.fromEntries(policies) }));
    this.configs = new Map(safe.map((c) => [c.id, c]));
    this.policies = policies;
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
    this.requireReady();
    return [...this.configs.values()].map((c) => structuredClone(c)).sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): McpServerConfig | undefined {
    this.requireReady();
    const config = this.configs.get(id); return config && structuredClone(config);
  }


  async upsert(cfg: McpServerConfig, store: { setSetting(k: string, v: string): void | Promise<void> }): Promise<McpServerConfig> {
    return this.change(async () => { const configs = new Map(this.configs); configs.set(cfg.id, structuredClone(cfg)); await this.persist(store, configs, new Map(this.policies)); return structuredClone(cfg); });
  }
  async remove(id: string, store: { setSetting(k: string, v: string): void | Promise<void> }): Promise<void> {
    return this.change(async () => {
      const cfg = this.configs.get(id); for (const name of cfg?.secretNames ?? []) await this.secrets.delete(`${id}.${name}`);
      const configs = new Map(this.configs), policies = new Map(this.policies); configs.delete(id); policies.delete(id);
      await this.persist(store, configs, policies);
    });
  }
  policy(id: string): McpPermissionPolicy { this.requireReady(); return structuredClone(this.policies.get(id) ?? { serverDefaults: {}, toolOverrides: {} }); }
  async updatePolicy(id: string, update: (policy: McpPermissionPolicy) => void, store: { setSetting(k: string, v: string): void | Promise<void> }): Promise<McpPermissionPolicy> {
    return this.change(async () => {
      const next = this.policy(id); update(next);
      const policies = new Map(this.policies); policies.set(id, structuredClone(next));
      await this.persist(store, new Map(this.configs), policies); return structuredClone(next);
    });
  }
  async setPolicy(id: string, policy: McpPermissionPolicy, store: { setSetting(k: string, v: string): void | Promise<void> }): Promise<void> {
    return this.change(async () => { const policies = new Map(this.policies); policies.set(id, structuredClone(policy)); await this.persist(store, new Map(this.configs), policies); });
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
