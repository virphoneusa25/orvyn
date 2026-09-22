import type { McpManager } from "../McpManager";
import {
  LoopbackCallback,
  buildAuthorizeUrl,
  discoverOAuthMetadata,
  exchangeCode,
  generatePkce,
  generateState,
  parseStoredTokens,
  refreshTokens,
  revokeToken,
  shouldRefresh,
  validateCallback,
  type OAuthFetch,
  type OAuthSession,
  type StoredOAuthTokens,
} from "./oauth";
import { McpCloudGateway } from "./gateway";
import { McpObservability } from "./observability";
import { inspectNpmPackage, pinRequired, type ProvenanceRecord } from "./provenance";
import { adminToolDenied, denyStartReason, readPolicy, writePolicy, type McpEnterprisePolicy } from "./policy";

const OAUTH_SECRET = "oauth";
const PROVENANCE_KEY = "mcp.provenance.v1";

export class McpHardening {
  readonly obs = new McpObservability();
  readonly gateway: McpCloudGateway;
  private sessions = new Map<string, OAuthSession>();
  private loopback = new LoopbackCallback();
  private refreshBackoff = new Map<string, number>();
  private fetchImpl: OAuthFetch;

  constructor(
    private manager: McpManager,
    private store: { getSetting(k: string): unknown; setSetting(k: string, v: string): void; deleteSetting?(k: string): void },
    readonly tenantId: string,
    fetchImpl?: OAuthFetch
  ) {
    this.fetchImpl = fetchImpl ?? (fetch as OAuthFetch);
    this.gateway = new McpCloudGateway(manager, () => this.policy(), this.obs);
  }

  policy(): McpEnterprisePolicy {
    return readPolicy(this.store);
  }

  setPolicy(next: Partial<McpEnterprisePolicy>): McpEnterprisePolicy {
    const merged = { ...this.policy(), ...next };
    writePolicy(this.store, merged);
    return merged;
  }

  denyServer(cfg: { id?: string; marketplaceId?: string; packageIdentifier?: string; sourceProviders?: string[]; trustLevel?: string }): string | null {
    return denyStartReason(this.policy(), cfg);
  }

  toolHardDenied(toolName: string): boolean {
    return adminToolDenied(this.policy(), toolName);
  }

  inScope(cfg: { scope?: string; cwd?: string }, projectRoot: string | null, runId?: string): boolean {
    const scope = cfg.scope ?? "global";
    if (scope === "global") return true;
    if (scope === "run") return Boolean(runId);
    if (scope === "project") {
      if (!projectRoot || !cfg.cwd) return false;
      const a = projectRoot.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
      const b = cfg.cwd.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
      return a === b || b.startsWith(a + "/") || a.startsWith(b + "/");
    }
    return true;
  }

  readProvenance(): Record<string, ProvenanceRecord> {
    try {
      const raw = this.store.getSetting(PROVENANCE_KEY);
      return raw ? (JSON.parse(String(raw)) as Record<string, ProvenanceRecord>) : {};
    } catch {
      return {};
    }
  }

  writeProvenance(serverId: string, rec: ProvenanceRecord): void {
    const all = this.readProvenance();
    all[serverId] = rec;
    this.store.setSetting(PROVENANCE_KEY, JSON.stringify(all));
  }

  async inspectInstall(identifier: string, version: string): Promise<ProvenanceRecord> {
    const pin = pinRequired(version);
    if (pin) throw new Error(pin);
    return inspectNpmPackage(identifier, version);
  }

  async startOAuth(input: { serverId: string; resource: string; clientId?: string }): Promise<{ authorizeUrl: string; state: string; redirectUri: string }> {
    const deny = this.denyServer({ id: input.serverId });
    if (deny) throw new Error(deny);
    const cfg = this.manager.listServers().find((s) => s.id === input.serverId);
    if (!cfg?.url && !input.resource) throw new Error("OAuth requires a remote MCP URL");
    const resource = input.resource || cfg?.url || "";
    const metadata = await discoverOAuthMetadata(resource, this.fetchImpl);
    const pkce = generatePkce();
    const state = generateState();
    const nonce = generateState();
    const redirectUri = await this.loopback.listen((q) => {
      void this.finishOAuth(state, q).catch(() => {});
    });
    const clientId = input.clientId || process.env.ORVYN_MCP_OAUTH_CLIENT_ID || "orvyn-mcp";
    const session: OAuthSession = {
      state,
      nonce,
      pkce,
      resource,
      serverId: input.serverId,
      tenantId: this.tenantId,
      redirectUri,
      clientId,
      metadata,
      createdAt: Date.now(),
      expiresAt: Date.now() + 120_000,
    };
    this.sessions.set(state, session);
    const authorizeUrl = buildAuthorizeUrl(metadata, {
      clientId,
      redirectUri,
      state,
      nonce,
      challenge: pkce.challenge,
      resource,
    });
    return { authorizeUrl, state, redirectUri };
  }

  async finishOAuth(state: string, query: Record<string, string>): Promise<{ serverId: string }> {
    const session = this.sessions.get(state);
    if (!session) throw new Error("Unknown or expired OAuth state");
    if (session.tenantId !== this.tenantId) throw new Error("OAuth session tenant mismatch");
    const code = validateCallback(session, query);
    const tokens = await exchangeCode(
      session.metadata,
      { code, redirectUri: session.redirectUri, clientId: session.clientId, verifier: session.pkce.verifier, resource: session.resource },
      this.fetchImpl
    );
    this.storeTokens(session.serverId, tokens);
    this.manager.updateServer(session.serverId, {
      authType: "bearer",
      authKind: "oauth",
      headers: { ...(this.manager.listServers().find((s) => s.id === session.serverId)?.headers ?? {}), Authorization: "Bearer {{oauth_access}}" },
    } as any);
    this.manager.setSecret(session.serverId, "oauth_access", tokens.access_token);
    this.sessions.delete(state);
    await this.loopback.close();
    this.appendAudit("connect", { serverId: session.serverId, method: "oauth" });
    await this.manager.connect(session.serverId);
    return { serverId: session.serverId };
  }

  oauthStatus(state: string): { pending: boolean; connected?: boolean } {
    return { pending: this.sessions.has(state) };
  }

  async ensureFreshToken(serverId: string): Promise<"ok" | "needs-auth"> {
    const cfg = this.manager.listServers().find((s) => s.id === serverId);
    if (cfg?.authKind && cfg.authKind !== "oauth") return "ok";
    const backoff = this.refreshBackoff.get(serverId) ?? 0;
    if (backoff > Date.now()) return "needs-auth";
    const raw = this.manager.secret(serverId, OAUTH_SECRET);
    const tokens = parseStoredTokens(raw);
    if (!tokens) {
      const access = this.manager.secret(serverId, "oauth_access");
      if (access) return "ok";
      if (cfg?.authKind === "oauth") return "needs-auth";
      return "ok";
    }
    if (!shouldRefresh(tokens)) return "ok";
    if (!tokens.refresh_token) return "needs-auth";
    if (!cfg?.url) return "needs-auth";
    try {
      const meta = await discoverOAuthMetadata(cfg.url, this.fetchImpl);
      const next = await refreshTokens(meta, { refreshToken: tokens.refresh_token, clientId: process.env.ORVYN_MCP_OAUTH_CLIENT_ID || "orvyn-mcp" }, this.fetchImpl);
      this.storeTokens(serverId, { ...tokens, ...next, refresh_token: next.refresh_token ?? tokens.refresh_token });
      this.refreshBackoff.delete(serverId);
      return "ok";
    } catch {
      this.refreshBackoff.set(serverId, Date.now() + 60_000);
      this.manager.markNeedsAuth(serverId, "OAuth refresh failed — Needs Auth");
      return "needs-auth";
    }
  }

  async disconnectAccount(serverId: string): Promise<void> {
    const raw = this.manager.secret(serverId, OAUTH_SECRET);
    const tokens = parseStoredTokens(raw);
    const cfg = this.manager.listServers().find((s) => s.id === serverId);
    if (tokens && cfg?.url) {
      try {
        const meta = await discoverOAuthMetadata(cfg.url, this.fetchImpl);
        if (tokens.access_token) await revokeToken(meta, tokens.access_token, this.fetchImpl);
        if (tokens.refresh_token) await revokeToken(meta, tokens.refresh_token, this.fetchImpl);
      } catch {
        /* revocation is best-effort */
      }
    }
    this.manager.deleteSecret(serverId, OAUTH_SECRET);
    this.manager.deleteSecret(serverId, "oauth_access");
    this.manager.markNeedsAuth(serverId, "Disconnected — Needs Auth");
    this.appendAudit("disconnect", { serverId });
  }

  appendAudit(kind: string, data: Record<string, unknown>): void {
    const raw = this.store.getSetting("mcp.audit.v1");
    let list: Array<Record<string, unknown>> = [];
    try {
      list = raw ? (JSON.parse(String(raw)) as Array<Record<string, unknown>>) : [];
    } catch {
      list = [];
    }
    const sanitized: Record<string, unknown> = { at: Date.now(), kind };
    for (const [k, v] of Object.entries(data)) {
      const key = k.toLowerCase();
      if (/(token|secret|password|authorization|api[_-]?key)/.test(key)) {
        sanitized[k] = "[redacted]";
      } else {
        sanitized[k] = v;
      }
    }
    list.push(sanitized);
    this.store.setSetting("mcp.audit.v1", JSON.stringify(list.slice(-200)));
  }

  readAudit(): Array<Record<string, unknown>> {
    try {
      const raw = this.store.getSetting("mcp.audit.v1");
      return raw ? (JSON.parse(String(raw)) as Array<Record<string, unknown>>) : [];
    } catch {
      return [];
    }
  }

  private storeTokens(serverId: string, tokens: StoredOAuthTokens): void {
    this.manager.setSecret(serverId, OAUTH_SECRET, JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: tokens.token_type,
      expires_at: tokens.expires_at,
      scope: tokens.scope,
    }));
    this.manager.setSecret(serverId, "oauth_access", tokens.access_token);
  }
}

const services = new WeakMap<McpManager, McpHardening>();

export function hardeningFor(
  manager: McpManager,
  store: { getSetting(k: string): unknown; setSetting(k: string, v: string): void; deleteSetting?(k: string): void },
  tenantId: string
): McpHardening {
  let s = services.get(manager);
  if (!s) {
    s = new McpHardening(manager, store, tenantId);
    services.set(manager, s);
  }
  return s;
}
