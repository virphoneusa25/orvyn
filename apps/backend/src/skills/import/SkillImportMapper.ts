import * as fs from "fs";
import * as path from "path";
import { registeredToolNames } from "../registeredToolNames";
import type { SkillMetadata } from "../types";
import { parseExternalSkill, type ParsedExternalSkill } from "./ExternalSkillParser";
import { buildSkillProvenance, licenseLabel } from "./SkillProvenance";
import { certificationBlockers, resolveExternalTools } from "./SkillImportValidator";

export interface ImportExternalSkillInput {
  sourceDir: string;
  outputDir: string;
  repository: string;
  path: string;
  importedAt?: string;
  knownTools?: Set<string>;
}

export interface ImportedSkillPackage {
  ok: true;
  packageDir: string;
  metadata: SkillMetadata;
  parsed: ParsedExternalSkill;
}

export interface RejectedSkillImport {
  ok: false;
  errors: string[];
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function safeDestination(root: string, rel: string): string {
  const normalized = rel.split("/").join(path.sep);
  if (normalized.split(path.sep).some((part) => part === ".." || part === "")) {
    throw new Error(`Refusing to copy ${rel}.`);
  }
  const dest = path.resolve(root, normalized);
  const base = path.resolve(root);
  if (dest !== base && !dest.startsWith(base + path.sep)) throw new Error(`Refusing to copy ${rel}.`);
  return dest;
}

function copyInert(sourceDir: string, packageDir: string, folder: string, files: string[]): void {
  for (const rel of files) {
    const from = path.join(sourceDir, folder, ...rel.split("/"));
    const dest = safeDestination(packageDir, `${folder}/${rel}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(from, dest);
    fs.chmodSync(dest, 0o644);
  }
}

/**
 * Convert an external SKILL.md package into an ORVYN package.
 * Scripts are copied as inert files and are not executed.
 */
export function importExternalSkill(input: ImportExternalSkillInput): ImportedSkillPackage | RejectedSkillImport {
  let parsed: ParsedExternalSkill;
  try {
    parsed = parseExternalSkill(input.sourceDir);
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : "Could not read the external skill."] };
  }
  const errors: string[] = [];
  if (!parsed.frontmatter.name) errors.push("SKILL.md frontmatter is missing name.");
  if (!parsed.frontmatter.description) errors.push("SKILL.md frontmatter is missing description.");
  const slug = slugify(parsed.frontmatter.name);
  if (!slug) errors.push("SKILL.md name cannot be turned into a package slug.");
  if (errors.length > 0) return { ok: false, errors };

  const known = input.knownTools ?? registeredToolNames();
  const resolved = resolveExternalTools(parsed.frontmatter.requiredToolNames, parsed.frontmatter.optionalToolNames, known);
  const license = licenseLabel(parsed.frontmatter.license, parsed.licenseFiles);
  const importedAt = input.importedAt?.trim() || new Date().toISOString();
  const origin = buildSkillProvenance({
    repository: input.repository,
    path: input.path,
    license,
    author: parsed.frontmatter.author,
    version: parsed.frontmatter.version,
    importedAt,
  });
  const blockers = certificationBlockers(origin.license, origin.repository, origin.path, resolved.unresolvedTools);
  const metadata: SkillMetadata = {
    id: `skill_import_${slug.replace(/-/g, "_")}`,
    slug,
    name: parsed.frontmatter.name,
    version: parsed.frontmatter.version || "0.0.0",
    description: parsed.frontmatter.description,
    category: parsed.frontmatter.category || "Imported",
    publisher: parsed.frontmatter.author || "third-party",
    source: "imported",
    builtIn: false,
    trusted: false,
    triggers: [parsed.frontmatter.name.toLowerCase()],
    taskDomains: ["imported"],
    runModes: ["agent"],
    requiredTools: resolved.requiredTools,
    optionalTools: resolved.optionalTools,
    permissionsRequired: [...resolved.requiredTools, ...resolved.optionalTools].map((id) => ({
      id,
      reason: "The imported skill named this ORVYN tool exactly. The skill is not certified.",
    })),
    validation: { rule: "Imported skill stays pending until certification. Unresolved external tools were not mapped." },
    tags: ["imported", "third-party"],
    scope: "personal",
    origin,
    certificationStatus: "pending",
    unresolvedTools: resolved.unresolvedTools,
    certificationBlockers: blockers,
  };

  const packageDir = path.join(input.outputDir, slug);
  fs.mkdirSync(packageDir, { recursive: true });
  const skillDest = path.join(packageDir, "SKILL.md");
  fs.writeFileSync(skillDest, parsed.rawMarkdown);
  copyInert(input.sourceDir, packageDir, "references", parsed.references);
  copyInert(input.sourceDir, packageDir, "templates", parsed.templates);
  copyInert(input.sourceDir, packageDir, "scripts", parsed.scripts);
  for (const name of parsed.licenseFiles) {
    const dest = safeDestination(packageDir, name);
    fs.copyFileSync(path.join(input.sourceDir, name), dest);
    fs.chmodSync(dest, 0o644);
  }
  fs.writeFileSync(path.join(packageDir, "skill.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  return { ok: true, packageDir, metadata, parsed };
}
