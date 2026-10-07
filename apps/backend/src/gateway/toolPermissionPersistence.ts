import type { TenantPersistence } from "../persistence/TenantPersistence";
import type { ToolRegistry, ToolPermission } from "../ai/ToolTypes";

/** Publish permission changes only after durable grants/overrides are updated. */
export async function persistToolPermission(tenant: {
  id: string;
  currentProjectRoot: string | null;
  localStore: Pick<TenantPersistence, "clearToolApprovalGrants" | "setToolOverride">;
  toolRegistry: Pick<ToolRegistry, "setPermission">;
}, subjectId: string, tool: string, permission: ToolPermission): Promise<void> {
  await tenant.localStore.clearToolApprovalGrants(subjectId, tool);
  if (tenant.currentProjectRoot) await tenant.localStore.setToolOverride(tenant.currentProjectRoot, tool, permission);
  tenant.toolRegistry.setPermission(tool, permission);
}
