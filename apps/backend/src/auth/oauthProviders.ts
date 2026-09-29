// apps/backend/src/auth/oauthProviders.ts
//
// Sign in with Google or GitHub: authorization code flow with state and
// PKCE (S256). The identity comes from the provider's API over TLS with the
// access token from the code exchange; only a VERIFIED email is accepted.
// Endpoints are overridable for tests (ORVYN_OAUTH_<PROVIDER>_*).

export type OAuthProviderId = "google" | "github";

export interface OAuthProfile { subject: string; email: string; emailVerified: boolean; name: string | null }

interface ProviderDef {
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  clientId?: string;
  clientSecret?: string;
  profile(accessToken: string): Promise<OAuthProfile>;
}

async function getJson(url: string, token: string): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "ORVYN" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`profile request failed (${res.status})`);
  return res.json();
}

export function oauthProvider(id: string, env: NodeJS.ProcessEnv = process.env): ProviderDef | null {
  if (id === "google") {
    const api = env.ORVYN_OAUTH_GOOGLE_API?.replace(/\/$/, "") || "https://openidconnect.googleapis.com";
    return {
      authorizeUrl: env.ORVYN_OAUTH_GOOGLE_AUTHORIZE || "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: env.ORVYN_OAUTH_GOOGLE_TOKEN || "https://oauth2.googleapis.com/token",
      scope: "openid email profile",
      clientId: env.GOOGLE_CLIENT_ID?.trim(),
      clientSecret: env.GOOGLE_CLIENT_SECRET?.trim(),
      async profile(token) {
        const u = await getJson(`${api}/v1/userinfo`, token);
        return { subject: String(u.sub), email: String(u.email ?? ""), emailVerified: u.email_verified === true || u.email_verified === "true", name: u.name ?? null };
      },
    };
  }
  if (id === "github") {
    const api = env.ORVYN_OAUTH_GITHUB_API?.replace(/\/$/, "") || "https://api.github.com";
    return {
      authorizeUrl: env.ORVYN_OAUTH_GITHUB_AUTHORIZE || "https://github.com/login/oauth/authorize",
      tokenUrl: env.ORVYN_OAUTH_GITHUB_TOKEN || "https://github.com/login/oauth/access_token",
      scope: "read:user user:email",
      clientId: env.GITHUB_CLIENT_ID?.trim(),
      clientSecret: env.GITHUB_CLIENT_SECRET?.trim(),
      async profile(token) {
        const u = await getJson(`${api}/user`, token);
        const emails = (await getJson(`${api}/user/emails`, token)) as { email: string; primary: boolean; verified: boolean }[];
        const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
        return { subject: String(u.id), email: primary?.email ?? "", emailVerified: Boolean(primary), name: u.name ?? u.login ?? null };
      },
    };
  }
  return null;
}

export function oauthConfigured(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const p = oauthProvider(id, env);
  return Boolean(p?.clientId && p?.clientSecret);
}

export function authorizeUrl(p: ProviderDef, input: { redirectUri: string; state: string; challenge: string; scope?: string }): string {
  const u = new URL(p.authorizeUrl);
  u.searchParams.set("client_id", p.clientId!);
  u.searchParams.set("redirect_uri", input.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", input.scope ?? p.scope);
  u.searchParams.set("state", input.state);
  u.searchParams.set("code_challenge", input.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("prompt", "select_account");
  u.searchParams.set("allow_signup", "true");
  return u.toString();
}

/** Exchanges the code (with the PKCE verifier) for an access token, then reads the profile. */
export async function exchangeCode(p: ProviderDef, input: { code: string; redirectUri: string; verifier: string }): Promise<OAuthProfile> {
  return (await exchangeCodeWithToken(p, input)).profile;
}

export async function exchangeCodeWithToken(p: ProviderDef, input: { code: string; redirectUri: string; verifier: string }): Promise<{ profile: OAuthProfile; accessToken: string; scope: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: p.clientId!,
    client_secret: p.clientSecret!,
    code_verifier: input.verifier,
  });
  const res = await fetch(p.tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body, signal: AbortSignal.timeout(15_000) });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; scope?: string };
  if (!res.ok || !data.access_token) throw new Error(`sign-in was not completed (${data.error ?? res.status})`);
  return { profile: await p.profile(data.access_token), accessToken: data.access_token, scope: String(data.scope ?? "") };
}
