/** Tenant / org / team / project binding. Isolation stays per TenantManager. */

export interface Organization {
  id: string;
  name: string;
  tenantId: string;
}

export interface Team {
  id: string;
  organizationId: string;
  name: string;
}

export interface OrgProject {
  id: string;
  organizationId: string;
  tenantId: string;
  name: string;
  projectRoot?: string | null;
}

export interface PrivacyPolicy {
  retentionMode: "standard" | "short" | "zero";
  trainingOptOut: boolean;
  localOnlyExecution: boolean;
  privateModelProvider: boolean;
}

export const DEFAULT_PRIVACY: PrivacyPolicy = {
  retentionMode: "standard",
  trainingOptOut: process.env.ORVYN_TRAINING_OPT_OUT === "1",
  localOnlyExecution: false,
  privateModelProvider: false,
};

export function bindTenantResource(tenantId: string, resourceTenantId: string): void {
  if (tenantId !== resourceTenantId) {
    const err = new Error("Not found") as Error & { status?: number };
    err.status = 404;
    throw err;
  }
}
