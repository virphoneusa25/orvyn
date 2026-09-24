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
  private aggregator: RegistryAggregator;
  private cache: CatalogCache<any>;

  constructor(
    private manager: McpManager,
    private store: { getSetting(k: string): unknown; setSetting(k: string, v: string): void },
    private tenantId = "local",
  ) {
    this.cache = new CatalogCache(settingCacheStore(this.store));
    this.aggregator = this.buildAggregator();
    this.index = new CapabilityIndex(manager, this.aggregator);
  }

  private readRegistries(): PrivateRegistryConfig[] {
    try {
      const raw = this.store.getSetting(REGISTRIES_KEY);
      return raw ? (JSON.parse(String(raw)) as PrivateRegistryConfig[]) : [];
    } catch {
      return [];
    }
  }

  private blocklist(): Set<string> {
    try {
      const raw = this.store.getSetting(BLOCKLIST_KEY);
      return new Set(raw ? (JSON.parse(String(raw)) as string[]) : []);
    } catch {
      return new Set();
    }
  }

  private secret(key: string): string {
    const stored = this.store.getSetting(key);
    if (typeof stored !== "string" || !stored.trim()) return "";
    const opened = openSecret(stored, this.tenantId, key);
    return opened?.trim() ? opened.trim() : "";
  }

  private writeSecret(key: string, value: string): void {
    this.store.setSetting(key, value ? sealSecret(value, this.tenantId, key) : "");
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
          const v = this.store.getSetting(name);
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
    return {
      glama: Boolean(this.secret("mcp.secret.glama") || process.env.GLAMA_API_KEY),
      smithery: Boolean(this.secret("mcp.secret.smithery") || process.env.SMITHERY_API_KEY),
    };
  }

  setProviderSecret(provider: "glama" | "smithery", token: string): { glama: boolean; smithery: boolean } {
    const key = provider === "glama" ? "mcp.secret.glama" : "mcp.secret.smithery";
    const value = validateProviderSecret(provider, token);
    this.writeSecret(key, value);
    this.refreshProviders();
    return this.providerSecretStatus();
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

  health() {
    return this.aggregator.health();
  }

  listPrivateRegistries(): PrivateRegistryConfig[] {
    return this.readRegistries().map((r) => ({ ...r }));
  }

  upsertPrivateRegistry(cfg: PrivateRegistryConfig, token?: string): PrivateRegistryConfig {
    const list = this.readRegistries().filter((r) => r.id !== cfg.id);
    list.push(cfg);
    this.store.setSetting(REGISTRIES_KEY, JSON.stringify(list));
    if (token) this.writeSecret(`mcp.secret.registry.${cfg.id}`, token);
    this.refreshProviders();
    return cfg;
  }

  removePrivateRegistry(id: string): void {
    this.store.setSetting(REGISTRIES_KEY, JSON.stringify(this.readRegistries().filter((r) => r.id !== id)));
    this.refreshProviders();
  }

  async install(server: MarketplaceMcpServer, opts: { secrets?: Record<string, string>; connect?: boolean; cwd?: string }) {
    if (this.blocklist().has(server.canonicalId)) throw new Error("This server is blocked by policy");
    return installMarketplaceServer(this.manager, { server, secrets: opts.secrets, cwd: opts.cwd, connect: opts.connect });
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

  importDrafts(drafts: ImportedServerDraft[], confirm: boolean) {
    if (!confirm) return { imported: 0, drafts };
    const existing = new Set(this.manager.listServers().map((s) => s.name.toLowerCase()));
    let imported = 0;
    for (const d of drafts) {
      if (existing.has(d.name.toLowerCase())) continue;
      this.manager.addServer({
        name: d.name,
        transport: d.transport,
        command: d.command,
        args: d.args,
        url: d.url,
        headers: d.headers,
        env: d.env,
        description: `Imported from ${d.sourceFormat} (secrets were stripped — re-enter in Tools & MCP)`,
      });
      imported += 1;
    }
    return { imported, drafts };
  }
}

const services = new WeakMap<McpManager, MarketplaceService>();

export function marketplaceFor(
  manager: McpManager,
  store: { getSetting(k: string): unknown; setSetting(k: string, v: string): void },
  tenantId = "local",
): MarketplaceService {
  let s = services.get(manager);
  if (!s) {
    s = new MarketplaceService(manager, store, tenantId);
    services.set(manager, s);
  }
  return s;
}
