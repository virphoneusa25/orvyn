export type OrgKind = "personal" | "company";
export type OrgRole = "owner" | "admin" | "member";

export interface Principal {
  userId: string;
  email: string;
  name: string | null;
  organizationId: string;
  organizationName: string;
  organizationKind: OrgKind;
  tenantId: string;
  role: OrgRole;
}

export interface OrganizationRecord {
  id: string;
  name: string;
  kind: OrgKind;
  tenantId: string;
  createdAt: number;
}

export interface TenantProject {
  id: string;
  tenantId: string;
  organizationId: string;
  userId: string;
  name: string;
  projectRoot?: string | null;
  createdAt: number;
}

export interface TenantChat {
  id: string;
  tenantId: string;
  organizationId: string;
  userId: string;
  title: string;
  createdAt: number;
}

export function environmentName(): "staging" | "production" | "local" {
  const raw = String(process.env.ORVYN_ENV ?? "").trim().toLowerCase();
  if (raw === "staging") return "staging";
  if (raw === "production" || process.env.ORVYN_CLOUD_MODE === "true") return "production";
  return "local";
}

export function personalTenantId(userId: string): string {
  return `user_${userId}`;
}
