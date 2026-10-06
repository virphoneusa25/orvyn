// apps/backend/src/integrations/githubConnection.ts
//
// A customer's GitHub connection (repository access), stored in their
// Personal Organization's tenant, sealed with the tenant-bound vault key.
// Never returned to any client; tools read it server-side.

import { authService } from "../auth/AsyncAuthService";
import { openSecret, sealSecret } from "../secrets/vault";
import { tenantManager } from "../tenancy/TenantManager";

async function tenantOf(userId: string) {
  const user = (await authService.getUser(userId));
  if (!user) return undefined;
  const personal = (await authService.ensurePersonalOrganization(user));
  return tenantManager.get(personal.tenantId) ?? tenantManager.ensureUserTenant(userId, personal.name || user.email);
}

export async function saveGithubConnection(userId: string, conn: { token: string; login: string; scope: string }): Promise<void> {
  const tenant = (await tenantOf(userId));
  if (!tenant) throw new Error("No workspace for this account yet.");
  tenant.localStore.setSetting("github.token", sealSecret(conn.token, tenant.id, "github.token"));
  tenant.localStore.setSetting("github.connection", JSON.stringify({ login: conn.login, scope: conn.scope, connectedAt: Date.now() }));
}

export async function githubConnection(userId: string): Promise<{ connected: boolean; login?: string; scope?: string }> {
  const tenant = (await tenantOf(userId));
  const meta = tenant?.localStore.getSetting("github.connection");
  if (!tenant || !meta || !tenant.localStore.getSetting("github.token")) return { connected: false };
  try { const m = JSON.parse(meta); return { connected: true, login: m.login, scope: m.scope }; } catch { return { connected: true }; }
}

/** Server-side only: the token for git operations on the customer's repositories. */
export function githubToken(tenantId: string): string | null {
  const tenant = tenantManager.get(tenantId);
  const sealed = tenant?.localStore.getSetting("github.token");
  return sealed ? openSecret(sealed, tenantId, "github.token") : null;
}

export async function disconnectGithub(userId: string): Promise<void> {
  const tenant = (await tenantOf(userId));
  tenant?.localStore.setSetting("github.token", "");
  tenant?.localStore.setSetting("github.connection", "");
}
