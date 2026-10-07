import type { McpManager } from "../McpManager";
import { RegistryAggregator } from "./aggregator";
import { CatalogCache, settingCacheStore } from "./catalogCache";
import { glamaProvider } from "./glamaProvider";
import { exportOrvynMcpConfig, parseImportedMcpConfig, type ImportedServerDraft } from "./importExport";
import { installMarketplaceServer } from "./install";
import { localProvider } from "./localProvider";
import { keepMarketplaceListing } from "./officialReference";
import { officialProvider } from "./officialProvider";
import { privateProvider, type PrivateRegistryConfig } from "./privateProvider";
import { smitheryProvider } from "./smitheryProvider";
import { CapabilityIndex } from "./searchCapabilities";
import { openSecret, sealSecret } from "../../secrets/vault";
import type { MarketplaceMcpServer, RegistrySearch } from "./types";
import { MARKETPLACE_CATALOG_VERSION, MARKETPLACE_INSTALL_API_VERSION, SUPPORTED_MARKETPLACE_PROVIDERS } from "./types";

const REGISTRIES_KEY = "mcp.marketplace.registries.v1";
const BLOCKLIST_KEY = "mcp.marketplace.blocklist.v1";

export function validateProviderSecret(provider: "glama" | "smithery", token: string): string {
  const value = token.trim();
  if (!value) return "";
  if (provider === "glama") {
    if (!value.startsWith("glm_")) {
      throw new Error("Glama keys start with glm_. Create one at glama.ai/settings/api-keys.");
    }
    return value;
  }
  if (value.startsWith("glm_") || value.startsWith("mcp_")) {
    throw new Error("That token is not a Smithery key. Use the UUID from smithery.ai.");
  }
  if (value.length < 16) {
    throw new Error("Smithery key is too short.");
  }
  return value;
}

export class MarketplaceService {
  readonly index: CapabilityIndex;
  readonly ready: Promise<void>;
  private initialized = false;
  private settings = new Map<string, unknown>();
  private writes: Promise<void> = Promise.resolve();
  private aggregator: RegistryAggregator;
  private cache: CatalogCache<any>;

  constructor(
    readonly manager: McpManager,
    private store: { getSetting(k: string): unknown; setSetting(k: string, v: string): void | Promise<void> },
    private tenantId = "local",
  ) {
    const keys = [REGISTRIES_KEY, BLOCKLIST_KEY, "mcp.secret.glama", "mcp.secret.smithery", "mcp.marketplace.catalogCache.v3"];
    const values = keys.map((key) => this.store.getSetting(key));
    this.cache = new CatalogCache();
    this.aggregator = this.buildAggregator();
    this.index = new CapabilityIndex(manager, this.aggregator);
    const hydrate = (resolved: unknown[]) => {
      keys.forEach((key, index) => this.settings.set(key, resolved[index]));
      const registries = this.readRegistries();
      const secrets = registries.map((reg) => this.store.getSetting(`mcp.secret.registry.${reg.id}`));
      const finish = (tokens: unknown[]) => {
        registries.forEach((reg, index) => this.settings.set(`mcp.secret.registry.${reg.id}`, tokens[index]));
        this.cache = new CatalogCache(settingCacheStore({
          getSetting: (key) => this.settings.get(key),
          setSetting: (key, value) => {
            // Catalog persistence is optional; serialize it and handle failures.
            void this.change(() => this.persist(key, value)).catch(() => {});
          },
        }));
        this.refreshProviders();
        this.initialized = true;
      };
      if (secrets.some((value) => value instanceof Promise)) return Promise.all(secrets).then(finish);
      finish(secrets);
    };
    this.ready = values.some((value) => value instanceof Promise)
      ? Promise.all(values).then(hydrate)
      : Promise.resolve(hydrate(values));
    void this.ready.catch(() => {});
  }

  private assertReady(): void {
    if (!this.initialized) throw new Error("MCP marketplace is not ready");
  }

  private change<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writes.then(async () => { await this.ready; return operation(); });
    this.writes = next.then(() => {}, () => {});
    return next;
  }

  private async persist(key: string, value: string): Promise<void> {
    await this.store.setSetting(key, value);
    this.settings.set(key, value);
  }

  async flushPersistence(): Promise<void> {
    await this.ready;
    await this.writes;
  }

  private readRegistries(): PrivateRegistryConfig[] {
    try {
      const raw = this.settings.get(REGISTRIES_KEY);
      return raw ? (JSON.parse(String(raw)) as PrivateRegistryConfig[]) : [];
    } catch {
      return [];
    }
  }

  private blocklist(): Set<string> {
    try {
      const raw = this.settings.get(BLOCKLIST_KEY);
      return new Set(raw ? (JSON.parse(String(raw)) as string[]) : []);
    } catch {
      return new Set();
    }
  }

  private secret(key: string): string {
    const stored = this.settings.get(key);
    if (typeof stored !== "string" || !stored.trim()) return "";
    const opened = openSecret(stored, this.tenantId, key);
    return opened?.trim() ? opened.trim() : "";
  }

  private async writeSecret(key: string, value: string): Promise<void> {
    await this.persist(key, value ? sealSecret(value, this.tenantId, key) : "");
  }

  private buildAggregator(): RegistryAggregator {
    const glamaKey = this.secret("mcp.secret.glama") || process.env.GLAMA_API_KEY || "";
    const smitheryKey = this.secret("mcp.secret.smithery") || process.env.SMITHERY_API_KEY || "";
    const providers = [
      officialProvider(),
      glamaProvider(fetch, glamaKey),
      smitheryProvider(fetch, smitheryKey),
      localProvider(this.manager),
    ];
    for (const reg of this.readRegistries()) {
      providers.push(
        privateProvider(reg, fetch, () => {
          const name = `mcp.secret.registry.${reg.id}`;
          const v = this.settings.get(name);
          if (typeof v !== "string" || !v) return null;
          return openSecret(v, this.tenantId, name);
        })
      );
    }
    return new RegistryAggregator(providers, this.cache);
  }

  refreshProviders(): void {
    this.aggregator = this.buildAggregator();
    this.index.aggregator = this.aggregator;
  }

  providerSecretStatus(): { glama: boolean; smithery: boolean } {
    this.assertReady();
    return {
      glama: Boolean(this.secret("mcp.secret.glama") || process.env.GLAMA_API_KEY),
      smithery: Boolean(this.secret("mcp.secret.smithery") || process.env.SMITHERY_API_KEY),
    };
  }

  async setProviderSecret(provider: "glama" | "smithery", token: string): Promise<{ glama: boolean; smithery: boolean }> {
    const key = provider === "glama" ? "mcp.secret.glama" : "mcp.secret.smithery";
    const value = validateProviderSecret(provider, token);
    return this.change(async () => {
      await this.writeSecret(key, value);
      this.refreshProviders();
      return this.providerSecretStatus();
    });
  }

  invalidateCatalog(query?: string): void {
    this.aggregator.invalidate(query);
  }

  capabilities() {
    return {
      marketplaceCatalogVersion: MARKETPLACE_CATALOG_VERSION,
      supportedProviders: [...SUPPORTED_MARKETPLACE_PROVIDERS],
      installApiVersion: MARKETPLACE_INSTALL_API_VERSION,
    };
  }

  async search(query: RegistrySearch) {
    await this.ready;
    const out = await this.aggregator.search(query);
    const blocked = this.blocklist();
    return {
      ...out,
      results: out.results.filter(
        (r) =>
          !blocked.has(r.server.canonicalId) &&
          r.server.trust.level !== "blocked" &&
          keepMarketplaceListing(r.server)
      ),
    };
  }

  async health() {
    await this.ready;
    return this.aggregator.health();
  }

  listPrivateRegistries(): PrivateRegistryConfig[] {
    this.assertReady();
    return structuredClone(this.readRegistries());
  }

  async upsertPrivateRegistry(cfg: PrivateRegistryConfig, token?: string): Promise<PrivateRegistryConfig> {
    const config = structuredClone(cfg);
    return this.change(async () => {
      const list = this.readRegistries().filter((r) => r.id !== config.id);
      list.push(config);
      if (token) await this.writeSecret(`mcp.secret.registry.${config.id}`, token);
      await this.persist(REGISTRIES_KEY, JSON.stringify(list));
      this.refreshProviders();
      return structuredClone(config);
    });
  }

  async removePrivateRegistry(id: string): Promise<void> {
    await this.change(async () => {
      await this.persist(REGISTRIES_KEY, JSON.stringify(this.readRegistries().filter((r) => r.id !== id)));
      this.refreshProviders();
    });
  }

  async install(server: MarketplaceMcpServer, opts: { secrets?: Record<string, string>; connect?: boolean; cwd?: string; preferStdio?: boolean }) {
    await this.ready;
    if (this.blocklist().has(server.canonicalId)) throw new Error("This server is blocked by policy");
    return installMarketplaceServer(this.manager, { server, secrets: opts.secrets, cwd: opts.cwd, connect: opts.connect, preferStdio: opts.preferStdio });
  }

  async featured(opts?: { refresh?: boolean }) {
    const out = await this.search({ query: "", limit: 48, refresh: opts?.refresh });
    return { ...out, results: out.results.slice(0, 48) };
  }

  updates() {
    return this.manager.listServers().map((cfg) => {
      const pinned = cfg.version ?? cfg.args?.find((a) => /@\d/.test(a))?.split("@").pop();
      return {
        serverId: cfg.id,
        name: cfg.name,
        current: pinned ?? "pinned-at-install",
        available: null as string | null,
        changelog: "ORVYN does not auto-upgrade executable MCP servers. Check the Official Registry for a newer pin, then Update explicitly.",
        transport: cfg.transport,
        enabled: cfg.enabled,
      };
    });
  }

  exportConfig() {
    return exportOrvynMcpConfig(this.manager.listServers());
  }

  previewImport(raw: unknown): ImportedServerDraft[] {
    return parseImportedMcpConfig(raw);
  }

   async importDrafts(drafts: ImportedServerDraft[], confirm: boolean) {
    if (!confirm) return { imported: 0, drafts };
    const existing = new Set(this.manager.listServers().map((s) => s.name.toLowerCase()));
    let imported = 0;
    for (const d of drafts) {
      if (existing.has(d.name.toLowerCase())) continue;
      (await this.manager.addServer({
        name: d.name,
        transport: d.transport,
        command: d.command,
        args: d.args,
        url: d.url,
        headers: d.headers,
        env: d.env,
        description: `Imported from ${d.sourceFormat} (secrets were stripped — re-enter in Tools & MCP)`,
      }));
      imported += 1;
    }
    return { imported, drafts };
  }
}

const services = new WeakMap<McpManager, MarketplaceService>();

export function marketplaceFor(
  manager: McpManager,
  store: { getSetting(k: string): unknown; setSetting(k: string, v: string): void | Promise<void> },
  tenantId = "local",
): MarketplaceService {
  let s = services.get(manager);
  if (!s) {
    s = new MarketplaceService(manager, store, tenantId);
    services.set(manager, s);
  }
  return s;
}
