import * as fs from "fs";
import * as path from "path";
import {
  SKILL_SCOPES,
  type CertificationStatus,
  type SkillDefinition,
  type SkillMetadata,
  type SkillOrigin,
  type SkillPermissionRequirement,
  type SkillRejection,
  type SkillScope,
  type SkillValidationRule,
  type UnresolvedTool,
} from "./types";

/** Shape the registry and the existing skill prompt already consume. */
export interface SkillPackage {
  id: string;
  name: string;
  /** Comma-separated triggers. Skill matching still splits this string. */
  trigger: string;
  description: string;
  requiredTools: string[];
  steps: string[];
  validation: string;
  scope: "tenant";
  confidence: number;
  sourceRuns: string[];
  validated: true;
  builtin: boolean;
  installed: true;
  category: string;
  version: string;
  source: string;
  dir: string;
  instructions: string;
  metadata: SkillMetadata;
}

export interface SkillLoadReport {
  skills: SkillPackage[];
  rejected: SkillRejection[];
}

/** Walk upward until resources/skills exists. Works from the repo root and from apps/backend. */
export function builtinSkillsRoot(start = process.cwd()): string {
  const override = process.env.ORVYN_SKILLS_DIR?.trim();
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`ORVYN_SKILLS_DIR does not exist: ${override}`);
    return override;
  }
  const origins = [start, __dirname];
  for (const origin of origins) {
    let dir = origin;
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, "resources", "skills");
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error("Built-in skills directory resources/skills was not found.");
}

function stepsFromMarkdown(markdown: string): string[] {
  const marker = "<!-- ORVYN-ADAPTED-STEPS -->";
  const source = markdown.includes(marker) ? markdown.split(marker).slice(1).join(marker) : markdown;
  return source
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*\d+\.\s+(.+)$/)?.[1]?.trim() ?? "")
    .filter(Boolean);
}

function needString(value: unknown, field: string, errors: string[]): string {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${field} must be a non-empty string.`);
    return "";
  }
  return value.trim();
}

function needBoolean(value: unknown, field: string, errors: string[]): boolean {
  if (typeof value !== "boolean") {
    errors.push(`${field} must be true or false.`);
    return false;
  }
  return value;
}

function needStringList(value: unknown, field: string, errors: string[], allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !String(item).trim())) {
    errors.push(`${field} must be an array of non-empty strings.`);
    return [];
  }
  if (!allowEmpty && value.length === 0) errors.push(`${field} must include at least one entry.`);
  return value.map((item) => String(item).trim());
}

function needPermissions(value: unknown, errors: string[]): SkillPermissionRequirement[] {
  if (!Array.isArray(value)) {
    errors.push("permissionsRequired must be an array.");
    return [];
  }
  const out: SkillPermissionRequirement[] = [];
  value.forEach((item, index) => {
    const row = item as { id?: unknown; reason?: unknown } | null;
    if (!row || typeof row !== "object" || typeof row.id !== "string" || !row.id.trim() || typeof row.reason !== "string" || !row.reason.trim()) {
      errors.push(`permissionsRequired[${index}] must include a non-empty id and reason.`);
      return;
    }
    out.push({ id: row.id.trim(), reason: row.reason.trim() });
  });
  return out;
}

function needValidation(value: unknown, errors: string[]): SkillValidationRule {
  const row = value as { rule?: unknown } | null;
  if (!row || typeof row !== "object" || typeof row.rule !== "string" || !row.rule.trim()) {
    errors.push("validation.rule must be a non-empty string.");
    return { rule: "" };
  }
  return { rule: row.rule.trim() };
}

function readOrigin(value: unknown, errors: string[]): SkillOrigin | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push("origin must be an object.");
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const fields = ["repository", "path", "license", "author", "version", "importedAt"] as const;
  const origin = {} as SkillOrigin;
  for (const field of fields) {
    if (typeof row[field] !== "string") {
      errors.push(`origin.${field} must be a string.`);
      origin[field] = "";
    } else {
      origin[field] = row[field];
    }
  }
  return origin;
}

function readCertification(value: unknown, errors: string[]): CertificationStatus | undefined {
  if (value === undefined) return undefined;
  if (value !== "pending" && value !== "certified" && value !== "rejected" && value !== "partially_supported" && value !== "blocked") {
    errors.push("certificationStatus must be pending, certified, rejected, partially_supported, or blocked.");
    return undefined;
  }
  return value;
}

function readUnresolved(value: unknown, errors: string[]): UnresolvedTool[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push("unresolvedTools must be an array.");
    return [];
  }
  const out: UnresolvedTool[] = [];
  value.forEach((item, index) => {
    const row = item as { name?: unknown; requirement?: unknown } | null;
    if (!row || typeof row !== "object" || typeof row.name !== "string" || !row.name.trim() || (row.requirement !== "required" && row.requirement !== "optional")) {
      errors.push(`unresolvedTools[${index}] must include a name and a requirement of required or optional.`);
      return;
    }
    out.push({ name: row.name.trim(), requirement: row.requirement });
  });
  return out;
}

function needScope(value: unknown, errors: string[]): SkillScope {
  if (typeof value !== "string" || !SKILL_SCOPES.includes(value as SkillScope)) {
    errors.push("scope must be builtin, personal, organization, or project.");
    return "builtin";
  }
  return value as SkillScope;
}

export function validateSkillPackage(dir: string): { skill: SkillPackage } | { rejection: SkillRejection } {
  const slug = path.basename(dir);
  const metaPath = path.join(dir, "skill.json");
  const bodyPath = path.join(dir, "SKILL.md");
  const errors: string[] = [];
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) errors.push("skill.json must be an object.");
  } catch {
    return { rejection: { slug, dir, errors: ["skill.json is not valid JSON."] } };
  }

  const metadata: SkillMetadata = {
    id: needString(raw.id, "id", errors),
    slug: needString(raw.slug, "slug", errors),
    name: needString(raw.name, "name", errors),
    version: needString(raw.version, "version", errors),
    description: needString(raw.description, "description", errors),
    category: needString(raw.category, "category", errors),
    publisher: needString(raw.publisher, "publisher", errors),
    source: needString(raw.source, "source", errors),
    builtIn: needBoolean(raw.builtIn, "builtIn", errors),
    trusted: needBoolean(raw.trusted, "trusted", errors),
    triggers: needStringList(raw.triggers, "triggers", errors, false),
    taskDomains: needStringList(raw.taskDomains, "taskDomains", errors, false),
    runModes: needStringList(raw.runModes, "runModes", errors, false),
    requiredTools: needStringList(raw.requiredTools, "requiredTools", errors, true),
    optionalTools: needStringList(raw.optionalTools, "optionalTools", errors, true),
    permissionsRequired: needPermissions(raw.permissionsRequired, errors),
    validation: needValidation(raw.validation, errors),
    tags: needStringList(raw.tags, "tags", errors, true),
    scope: needScope(raw.scope, errors),
  };
  const origin = readOrigin(raw.origin, errors);
  const certificationStatus = readCertification(raw.certificationStatus, errors);
  const unresolvedTools = readUnresolved(raw.unresolvedTools, errors);
  const certificationBlockers = raw.certificationBlockers === undefined
    ? undefined
    : needStringList(raw.certificationBlockers, "certificationBlockers", errors, true);
  const relatedSkillIds = raw.relatedSkillIds === undefined
    ? undefined
    : needStringList(raw.relatedSkillIds, "relatedSkillIds", errors, true);
  if (origin) metadata.origin = origin;
  if (certificationStatus) metadata.certificationStatus = certificationStatus;
  if (unresolvedTools) metadata.unresolvedTools = unresolvedTools;
  if (certificationBlockers) metadata.certificationBlockers = certificationBlockers;
  if (relatedSkillIds) metadata.relatedSkillIds = relatedSkillIds;
  if (metadata.slug && metadata.slug !== slug) errors.push(`slug must match the package directory (${slug}).`);

  let instructions = "";
  if (!fs.existsSync(bodyPath)) errors.push("SKILL.md is missing.");
  else {
    try {
      instructions = fs.readFileSync(bodyPath, "utf8");
    } catch (err) {
      errors.push(err instanceof Error ? err.message : "SKILL.md could not be read.");
    }
  }
  const steps = stepsFromMarkdown(instructions);
  if (fs.existsSync(bodyPath) && steps.length === 0) errors.push("SKILL.md must include numbered steps.");
  if (errors.length > 0) return { rejection: { slug, dir, errors } };

  const definition: SkillDefinition = { metadata, steps, instructions, dir };
  return {
    skill: {
      id: metadata.id,
      name: metadata.name,
      trigger: metadata.triggers.join(", "),
      description: metadata.description,
      requiredTools: metadata.requiredTools,
      steps,
      validation: metadata.validation.rule,
      scope: "tenant",
      confidence: 1,
      sourceRuns: ["seed"],
      validated: true,
      builtin: metadata.builtIn,
      installed: true,
      category: metadata.category,
      version: metadata.version,
      source: metadata.source,
      dir,
      instructions,
      metadata: definition.metadata,
    },
  };
}

export function importedSkillsRoot(start = process.cwd()): string | null {
  const origins = [start, __dirname];
  for (const origin of origins) {
    let dir = origin;
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, "resources", "imported-skills");
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

function packageDirs(root: string, recursive: boolean): string[] {
  if (!recursive) {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name))
      .filter((dir) => fs.existsSync(path.join(dir, "skill.json")))
      .sort();
  }
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === "skill.json")) {
      found.push(dir);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".git" || entry.name === "node_modules") continue;
      walk(path.join(dir, entry.name));
    }
  };
  walk(root);
  return found.sort();
}

export class SkillLoader {
  constructor(private readonly root = builtinSkillsRoot(), private readonly recursive = false) {}

  /** Validate every package. A malformed skill is reported and skipped. */
  load(): SkillLoadReport {
    let dirs: string[] = [];
    try {
      dirs = packageDirs(this.root, this.recursive);
    } catch (err) {
      return {
        skills: [],
        rejected: [{ slug: path.basename(this.root), dir: this.root, errors: [err instanceof Error ? err.message : "Could not read the skills directory."] }],
      };
    }
    const skills: SkillPackage[] = [];
    const rejected: SkillRejection[] = [];
    const seen = new Set<string>();
    for (const dir of dirs) {
      const name = path.basename(dir);
      if (!fs.existsSync(path.join(dir, "skill.json"))) continue;
      try {
        const result = validateSkillPackage(dir);
        if ("rejection" in result) {
          rejected.push(result.rejection);
          continue;
        }
        if (seen.has(result.skill.id)) {
          rejected.push({ slug: name, dir, errors: [`id ${result.skill.id} is already used by another package.`] });
          continue;
        }
        seen.add(result.skill.id);
        skills.push(result.skill);
      } catch (err) {
        rejected.push({ slug: name, dir, errors: [err instanceof Error ? err.message : "Could not load this skill."] });
      }
    }
    return { skills, rejected };
  }
}
