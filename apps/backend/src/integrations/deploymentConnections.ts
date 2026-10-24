import { openSecret, sealSecret } from "../secrets/vault";
import { tenantManager } from "../tenancy/TenantManager";

export const DEPLOYMENT_INTEGRATIONS = ["vercel", "netlify", "cloudflare"] as const;
export type DeploymentIntegration = typeof DEPLOYMENT_INTEGRATIONS[number];

const ENV_NAME: Record<DeploymentIntegration, string> = {
  vercel: "VERCEL_TOKEN",
  netlify: "NETLIFY_AUTH_TOKEN",
  cloudflare: "CLOUDFLARE_API_TOKEN",
};

function valid(id: string): id is DeploymentIntegration {
  return (DEPLOYMENT_INTEGRATIONS as readonly string[]).includes(id);
}

function key(id: DeploymentIntegration): string { return `integration.${id}.token`; }

export async function deploymentConnections(tenantId: string): Promise<Record<DeploymentIntegration, { connected: boolean }>> {
  const store = tenantManager.get(tenantId)?.localStore;
  return Object.fromEntries(await Promise.all(DEPLOYMENT_INTEGRATIONS.map(async (id) => [id, { connected: Boolean(await store?.getSetting(key(id))) }]))) as Record<DeploymentIntegration, { connected: boolean }>;
}

export async function saveDeploymentConnection(tenantId: string, id: string, token: string): Promise<void> {
  if (!valid(id)) throw Object.assign(new Error("Unknown deployment provider."), { status: 404 });
  const value = token.trim();
  if (value.length < 12 || value.length > 4096) throw Object.assign(new Error("Enter a valid provider token."), { status: 400 });
  const store = tenantManager.get(tenantId)?.localStore;
  if (!store) throw Object.assign(new Error("Workspace unavailable."), { status: 404 });
  await store.setSetting(key(id), sealSecret(value, tenantId, key(id)));
}

export async function removeDeploymentConnection(tenantId: string, id: string): Promise<void> {
  if (!valid(id)) throw Object.assign(new Error("Unknown deployment provider."), { status: 404 });
  await tenantManager.get(tenantId)?.localStore.setSetting(key(id), "");
}

/** Server-side only. Returned directly to the OpenShell credential broker. */
export async function deploymentCredential(tenantId: string, id: string): Promise<Record<string, string> | null> {
  if (!valid(id)) return null;
  const sealed = await tenantManager.get(tenantId)?.localStore.getSetting(key(id));
  if (!sealed) return null;
  const token = openSecret(sealed, tenantId, key(id));
  return token ? { [ENV_NAME[id]]: token } : null;
}
