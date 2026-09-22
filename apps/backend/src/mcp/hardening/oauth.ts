// Generic MCP OAuth (Authorization Code + PKCE S256). Discovers standard
// metadata; never uses implicit flow. Tokens stay in the secret store.

import { createHash, randomBytes } from "crypto";
import { createServer, type Server } from "http";

export interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  registration_endpoint?: string;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

export interface OAuthSession {
  state: string;
  nonce: string;
  pkce: PkcePair;
  resource: string;
  serverId: string;
  tenantId: string;
  redirectUri: string;
  clientId: string;
  metadata: OAuthMetadata;
  createdAt: number;
  expiresAt: number;
}

export interface StoredOAuthTokens {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_at?: number;
  scope?: string;
}

export type OAuthFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
  text: () => Promise<string>;
}>;

export function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function generatePkce(): PkcePair {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

export function generateState(): string {
  return base64url(randomBytes(24));
}

export function buildAuthorizeUrl(meta: OAuthMetadata, opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce?: string;
  challenge: string;
  resource?: string;
  scope?: string;
}): string {
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("state", opts.state);
  u.searchParams.set("code_challenge", opts.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (opts.nonce) u.searchParams.set("nonce", opts.nonce);
  if (opts.scope) u.searchParams.set("scope", opts.scope);
  if (opts.resource) u.searchParams.set("resource", opts.resource);
  return u.toString();
}

export function validateCallback(session: OAuthSession, query: { state?: string; code?: string; error?: string }, now = Date.now()): string {
  if (now > session.expiresAt) throw new Error("OAuth session expired");
  if (!query.state || query.state !== session.state) throw new Error("OAuth state mismatch");
  if (query.error) throw new Error(`OAuth provider error: ${query.error}`);
  if (!query.code) throw new Error("OAuth callback missing authorization code");
  return query.code;
}

export async function discoverOAuthMetadata(resourceUrl: string, fetchImpl: OAuthFetch = fetch as OAuthFetch): Promise<OAuthMetadata> {
  const origin = new URL(resourceUrl).origin;
  const asWellKnown = await tryJson(fetchImpl, `${origin}/.well-known/oauth-authorization-server`);
  if (asWellKnown?.authorization_endpoint && asWellKnown?.token_endpoint) {
    return {
      authorization_endpoint: String(asWellKnown.authorization_endpoint),
      token_endpoint: String(asWellKnown.token_endpoint),
      revocation_endpoint: asWellKnown.revocation_endpoint ? String(asWellKnown.revocation_endpoint) : undefined,
      registration_endpoint: asWellKnown.registration_endpoint ? String(asWellKnown.registration_endpoint) : undefined,
    };
  }
  const pr = await tryJson(fetchImpl, `${origin}/.well-known/oauth-protected-resource`);
  const as = Array.isArray(pr?.authorization_servers) ? String(pr.authorization_servers[0] ?? "") : "";
  if (as) {
    const meta = await tryJson(fetchImpl, `${as.replace(/\/$/, "")}/.well-known/oauth-authorization-server`);
    if (meta?.authorization_endpoint && meta?.token_endpoint) {
      return {
        authorization_endpoint: String(meta.authorization_endpoint),
        token_endpoint: String(meta.token_endpoint),
        revocation_endpoint: meta.revocation_endpoint ? String(meta.revocation_endpoint) : undefined,
        registration_endpoint: meta.registration_endpoint ? String(meta.registration_endpoint) : undefined,
      };
    }
  }
  throw new Error("This MCP server did not advertise standard OAuth metadata (authorization + token endpoints).");
}

export async function exchangeCode(
  meta: OAuthMetadata,
  input: { code: string; redirectUri: string; clientId: string; verifier: string; resource?: string },
  fetchImpl: OAuthFetch = fetch as OAuthFetch,
  now = Date.now()
): Promise<StoredOAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.verifier,
  });
  if (input.resource) body.set("resource", input.resource);
  return tokenRequest(meta.token_endpoint, body, fetchImpl, now);
}

export async function refreshTokens(
  meta: OAuthMetadata,
  input: { refreshToken: string; clientId: string; resource?: string },
  fetchImpl: OAuthFetch = fetch as OAuthFetch,
  now = Date.now()
): Promise<StoredOAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.clientId,
  });
  if (input.resource) body.set("resource", input.resource);
  return tokenRequest(meta.token_endpoint, body, fetchImpl, now);
}

export function shouldRefresh(tokens: StoredOAuthTokens, now = Date.now(), skewMs = 60_000): boolean {
  if (!tokens.expires_at) return false;
  return tokens.expires_at - skewMs <= now;
}

export function parseStoredTokens(raw: string | null): StoredOAuthTokens | null {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as StoredOAuthTokens;
    if (!t.access_token) return null;
    return t;
  } catch {
    return null;
  }
}

export async function revokeToken(
  meta: OAuthMetadata,
  token: string,
  fetchImpl: OAuthFetch = fetch as OAuthFetch
): Promise<boolean> {
  if (!meta.revocation_endpoint) return false;
  try {
    const res = await fetchImpl(meta.revocation_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    return res.ok || res.status === 200 || res.status === 204;
  } catch {
    return false;
  }
}

export class LoopbackCallback {
  private server: Server | null = null;
  private timer: NodeJS.Timeout | null = null;

  async listen(onQuery: (q: Record<string, string>) => void, ttlMs = 120_000): Promise<string> {
    await this.close();
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const q: Record<string, string> = {};
      url.searchParams.forEach((v, k) => {
        q[k] = v;
      });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body style='font-family:sans-serif;background:#0B0E14;color:#E8ECF4;padding:32px'>You can return to ORVYN. This window may be closed.</body></html>");
      onQuery(q);
      void this.close();
    });
    const port = await new Promise<number>((resolve, reject) => {
      this.server!.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("loopback bind failed"));
      });
      this.server!.on("error", reject);
    });
    this.timer = setTimeout(() => void this.close(), ttlMs);
    return `http://127.0.0.1:${port}/callback`;
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const s = this.server;
    this.server = null;
    if (!s) return;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
}

async function tokenRequest(url: string, body: URLSearchParams, fetchImpl: OAuthFetch, now: number): Promise<StoredOAuthTokens> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`OAuth token endpoint HTTP ${res.status}${json.error ? `: ${json.error}` : ""}`);
  }
  const expiresIn = Number(json.expires_in);
  return {
    access_token: String(json.access_token),
    refresh_token: json.refresh_token ? String(json.refresh_token) : undefined,
    token_type: json.token_type ? String(json.token_type) : "Bearer",
    expires_at: Number.isFinite(expiresIn) ? now + expiresIn * 1000 : undefined,
    scope: json.scope ? String(json.scope) : undefined,
  };
}

async function tryJson(fetchImpl: OAuthFetch, url: string): Promise<any | null> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
