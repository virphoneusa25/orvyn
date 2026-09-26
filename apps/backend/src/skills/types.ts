/** Packaged skill layout: resources/skills/<slug>/skill.json and SKILL.md. */

export type SkillScope = "builtin" | "personal" | "organization" | "project";

export const SKILL_SCOPES: readonly SkillScope[] = ["builtin", "personal", "organization", "project"];

export interface SkillPermissionRequirement {
  id: string;
  reason: string;
}

export interface SkillValidationRule {
  rule: string;
}

/** Where an imported skill came from. Built-in packages omit this. */
export interface SkillOrigin {
  repository: string;
  path: string;
  license: string;
  author: string;
  version: string;
  importedAt: string;
}

export type CertificationStatus = "pending" | "certified" | "rejected";

/** An external tool name that was not mapped onto an ORVYN tool. */
export interface UnresolvedTool {
  name: string;
  requirement: "required" | "optional";
}

export interface SkillMetadata {
  id: string;
  slug: string;
  name: string;
  version: string;
  description: string;
  category: string;
  publisher: string;
  source: string;
  builtIn: boolean;
  trusted: boolean;
  triggers: string[];
  taskDomains: string[];
  runModes: string[];
  requiredTools: string[];
  optionalTools: string[];
  permissionsRequired: SkillPermissionRequirement[];
  validation: SkillValidationRule;
  tags: string[];
  scope: SkillScope;
  origin?: SkillOrigin;
  certificationStatus?: CertificationStatus;
  unresolvedTools?: UnresolvedTool[];
  certificationBlockers?: string[];
}

/** A package that passed validation, including the playbook body. */
export interface SkillDefinition {
  metadata: SkillMetadata;
  steps: string[];
  instructions: string;
  dir: string;
}

export interface SkillRejection {
  slug: string;
  dir: string;
  errors: string[];
}
