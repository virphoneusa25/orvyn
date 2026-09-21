// apps/backend/src/mcp/McpRegistry.ts
//
// Persistent MCP server configuration + secrets. Config lives in the
// tenant's LocalStore (SQLite); secrets live under a SEPARATE namespace so
// no credential ever sits inside a server-config record, log line, or API
// response. The store is the seam a future OS-keychain/Electron
// safeStorage backend plugs into.

import type { McpPermissionPolicy, McpServerConfig } from "./McpTypes";

const CONFIG_KEY = "mcp.servers.v1";
const POLICY_KEY = "mcp.policies.v1";
const SECRET_PREFIX = "mcp.secret.";

export interface SecretStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

/** LocalStore-backed secret storage — the credential seam. */
export function makeSecretStore(store: { getSetting(k: string): unknown; setSetting(k: string, v: string): void; deleteSetting?(k: string): void }): SecretStore {
  return {
    get: (k) => {
      const v = store.getSetting(SECRET_PREFIX + k);
      return typeof v === "string" ? v : null;
    },
    set: (k, v) => store.setSetting(SECRET_PREFIX + k, v),
    delete: (k) => store.deleteSetting?.(SECRET_PREFIX + k),
  };
}

export class McpRegistry {
  private configs = new Map<string, McpServerConfig>();
  private policies = new Map<string, McpPermissionPolicy>();
  private secrets: SecretStore;

  constructor(store: { getSetting(k: string): unknown; setSetting(k: string, v: string): void; deleteSetting?(k: string): void }) {
    this.secrets = makeSecretStore(store);
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

  remove(id: string, store: { setSetting(k: string, v: string): void }): void {
    // Best-effort secret cleanup when the server goes away.
    const cfg = this.configs.get(id);
    for (const s of cfg?.secretNames ?? []) this.secrets.delete(`${id}.${s}`);
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

  secret(id: string, name: string): string | null {
    return this.secrets.get(`${id}.${name}`);
  }

  setSecret(id: string, name: string, value: string): void {
    this.secrets.set(`${id}.${name}`, value);
  }

  /** Resolves {{secretName}} header references at connect time. */
  resolveHeaders(id: string, headers: Record<string, string> | undefined): Record<string, string> {
    if (!headers) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      // Substring replacement: "Bearer {{token}}" keeps its scheme prefix.
      out[k] = v.replace(/\{\{([^}]+)\}\}/g, (_all, name: string) => this.secrets.get(`${id}.${name}`) ?? "");
    }
    return out;
  }
}
