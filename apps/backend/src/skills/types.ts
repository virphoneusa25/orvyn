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
