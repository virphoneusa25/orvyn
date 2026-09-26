import * as fs from "fs";
import * as path from "path";
import { skillRegistry, type RegistrySkill } from "./SkillRegistry";
import { readSkillQualityReport, qualityIndex } from "./quality/SkillQualityReport";
import type { QualityStatus } from "./quality/SkillQualityEvaluator";
import type { DuplicateDecision } from "./quality/SkillConflictDetector";
import { registeredToolNames } from "./registeredToolNames";

export const DISPLAY_GROUPS = [
  "Software Engineering",
  "Browser & UI",
  "Infrastructure & DevOps",
  "Systems & Open Source",
  "Telecom Engineering",
  "AI & Machine Learning",
  "Data & Analytics",
  "Research & Analysis",
  "Security",
  "System Administration",
  "Productivity",
  "Communication",
  "Business & Strategy",
  "Design & Media",
  "Artifacts & Content",
  "Other",
] as const;

export type DisplayGroup = (typeof DISPLAY_GROUPS)[number];

export interface CatalogSkill {
  id: string;
  name: string;
  description: string;
  category: string;
  group: DisplayGroup;
  tags: string[];
  triggers: string[];
  version: string;
  source: "builtin" | "imported";
  builtin: boolean;
  enabled: boolean;
  certificationStatus: string;
  qualityStatus: QualityStatus | null;
  qualityScore: number | null;
  publisher: string;
  author: string;
  updatedAt: string | null;
  requiredTools: string[];
  optionalTools: string[];
  unresolvedTools: Array<{ name: string; requirement: "required" | "optional" }>;
}

export interface CatalogCounts {
  total: number;
  builtin: number;
  imported: number;
  approved: number;
  needsRevision: number;
  disabled: number;
  certified: number;
  partiallySupported: number;
  blocked: number;
}

export interface CatalogPayload {
  skills: CatalogSkill[];
  counts: CatalogCounts;
  categories: Array<{ label: DisplayGroup; count: number }>;
}

export type ToolAvailability = "available" | "unavailable" | "optional";

export interface CatalogTool {
  name: string;
  requirement: "required" | "optional" | "unresolved";
  registered: boolean;
  permissionMapped: boolean;
  available: boolean;
  availability: ToolAvailability;
}

export interface SkillFileEntry {
  path: string;
  kind: "skill" | "reference" | "template" | "script" | "package";
  bytes: number;
  executable: false;
  inert: boolean;
}

const TEXT_LIMIT = 200_000;

export function displayCategory(raw: string): DisplayGroup {
  const value = raw.trim();
  const low = value.toLowerCase();
  if (value === "Systems & Open Source") return "Systems & Open Source";
  if (value === "Telecom Engineering" || low === "telecom") return "Telecom Engineering";
  if (value === "Browser & UI") return "Browser & UI";
  if (value === "Server & DevOps") return "Infrastructure & DevOps";
  if (value === "Artifacts & Content") return "Artifacts & Content";
  if (value === "Research & Analysis" || low === "research" || low === "research-ops") return "Research & Analysis";
  if (low === "ra-qm-team" || low === "compliance-os" || low.includes("security") || low.includes("audit")) return "Security";
  if (low === "engineering" || low === "engineering-team" || value === "Engineering" || value === "Engineering / Code Quality") return "Software Engineering";
  if (low === "agent-launcher" || low.includes("machine learning") || low === "ai") return "AI & Machine Learning";
  if (low.includes("data") || low.includes("analytics")) return "Data & Analytics";
  if (low.includes("admin")) return "System Administration";
  if (low === "productivity" || low === "project-management" || low === "loop-library") return "Productivity";
  if (low.includes("communication")) return "Communication";
  if (
    low === "marketing" || low === "marketing-skill" || low === "commercial" ||
    low === "business-operations" || low === "business-growth" || low === "finance" ||
    low.startsWith("c-level") || low === "product" || low === "product-team"
  ) return "Business & Strategy";
  if (low === "design" || low === "markdown-html") return "Design & Media";
  return "Other";
}

function sourceOf(skill: RegistrySkill): "builtin" | "imported" {
  if (skill.builtin || skill.metadata.builtIn) return "builtin";
  return "imported";
}

function triggersOf(skill: RegistrySkill): string[] {
  if (skill.metadata.triggers?.length) return skill.metadata.triggers;
  return (skill.trigger || "").split(",").map((part) => part.trim()).filter(Boolean);
}

function updatedAt(skill: RegistrySkill): string | null {
  try {
    return fs.statSync(path.join(skill.dir, "skill.json")).mtime.toISOString();
  } catch {
    return skill.metadata.origin?.importedAt || null;
  }
}

export function summarizeSkill(skill: RegistrySkill): CatalogSkill {
  const quality = qualityIndex().get(skill.id);
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    category: skill.metadata.category || skill.category,
    group: displayCategory(skill.metadata.category || skill.category),
    tags: skill.metadata.tags ?? [],
    triggers: triggersOf(skill),
    version: skill.version,
    source: sourceOf(skill),
    builtin: sourceOf(skill) === "builtin",
    enabled: skill.enabled,
    certificationStatus: skill.metadata.certificationStatus ?? "",
    qualityStatus: quality?.qualityStatus ?? null,
    qualityScore: quality?.qualityScore ?? null,
    publisher: skill.metadata.publisher || "",
    author: skill.metadata.origin?.author || skill.metadata.publisher || "",
    updatedAt: updatedAt(skill),
    requiredTools: skill.metadata.requiredTools?.length ? skill.metadata.requiredTools : skill.requiredTools ?? [],
    optionalTools: skill.metadata.optionalTools ?? [],
    unresolvedTools: (skill.metadata.unresolvedTools ?? []).map((tool) => ({ name: tool.name, requirement: tool.requirement })),
  };
}

export function skillSearchText(skill: CatalogSkill): string {
  return [skill.name, skill.description, skill.category, skill.group, ...skill.tags, ...skill.triggers].join("\n").toLowerCase();
}

export function skillCatalog(): CatalogPayload {
  const skills = skillRegistry.list().map(summarizeSkill);
  const counts: CatalogCounts = {
    total: skills.length,
    builtin: skills.filter((skill) => skill.source === "builtin").length,
    imported: skills.filter((skill) => skill.source === "imported").length,
    approved: skills.filter((skill) => skill.qualityStatus === "approved").length,
    needsRevision: skills.filter((skill) => skill.qualityStatus === "needs_revision").length,
    disabled: skills.filter((skill) => skill.qualityStatus === "disabled").length,
    certified: skills.filter((skill) => skill.certificationStatus === "certified").length,
    partiallySupported: skills.filter((skill) => skill.certificationStatus === "partially_supported").length,
    blocked: skills.filter((skill) => skill.certificationStatus === "blocked").length,
  };
  const categories = DISPLAY_GROUPS.map((label) => ({
    label,
    count: skills.filter((skill) => skill.group === label).length,
  })).filter((row) => row.count > 0);
  return { skills, counts, categories };
}

function findSkill(id: string): RegistrySkill | undefined {
  return skillRegistry.list().find((skill) => skill.id === id);
}

let knownTools: Set<string> | null = null;

function toolNames(): Set<string> {
  if (!knownTools) knownTools = registeredToolNames();
  return knownTools;
}

function toolView(name: string, requirement: CatalogTool["requirement"]): CatalogTool {
  const registered = toolNames().has(name);
  const availability: ToolAvailability = registered ? "available" : requirement === "optional" ? "optional" : "unavailable";
  return {
    name,
    requirement,
    registered,
    permissionMapped: registered,
    available: registered,
    availability,
  };
}

function sectionText(markdown: string, heading: RegExp): string | null {
  const lines = markdown.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^#{1,3}\s+/.test(lines[i]) && heading.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;
  const body: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    if (/^#{1,3}\s+/.test(lines[i])) break;
    body.push(lines[i]);
  }
  const text = body.join("\n").trim();
  return text || null;
}

function whenToUse(description: string, markdown: string): string | null {
  const section = sectionText(markdown, /when to use/i);
  if (section) return section;
  const match = description.match(/Use when[^.]*(?:\.|$)/i);
  return match?.[0]?.trim() || null;
}

function readInstructions(skill: RegistrySkill): string {
  try {
    return fs.readFileSync(path.join(skill.dir, "SKILL.md"), "utf8");
  } catch {
    return skill.instructions || "";
  }
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

function fileKind(rel: string): SkillFileEntry["kind"] {
  if (rel === "SKILL.md") return "skill";
  if (rel.startsWith("references/")) return "reference";
  if (rel.startsWith("templates/")) return "template";
  if (rel.startsWith("scripts/")) return "script";
  return "package";
}

function isInert(rel: string): boolean {
  return rel.startsWith("scripts/") || /\.(py|sh|bash|js|mjs|cjs|ts|rb|php)$/i.test(rel);
}

function walkFiles(dir: string): SkillFileEntry[] {
  let root = path.resolve(dir);
  try {
    root = fs.realpathSync(root);
  } catch {
    return [];
  }
  const out: SkillFileEntry[] = [];
  const visit = (current: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const abs = path.join(current, entry.name);
      let real = abs;
      let stat: fs.Stats;
      try {
        real = fs.realpathSync(abs);
        stat = fs.statSync(real);
      } catch {
        continue;
      }
      if (!inside(root, real)) continue;
      if (stat.isDirectory()) {
        visit(real);
        continue;
      }
      if (!stat.isFile()) continue;
      const rel = path.relative(root, real).split(path.sep).join("/");
      if (!rel || rel === "skill.json") continue;
      out.push({ path: rel, kind: fileKind(rel), bytes: stat.size, executable: false, inert: isInert(rel) });
    }
  };
  visit(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function listSkillFiles(id: string): SkillFileEntry[] {
  const skill = findSkill(id);
  if (!skill) throw new Error("Unknown skill.");
  return walkFiles(path.resolve(skill.dir));
}

export function readSkillFile(id: string, relPath: string): { path: string; content: string; truncated: boolean; executable: false; inert: boolean; bytes: number } {
  const skill = findSkill(id);
  if (!skill) throw new Error("Unknown skill.");
  const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel || rel.includes("..") || path.isAbsolute(relPath)) throw new Error("That file path is not available.");
  let root = path.resolve(skill.dir);
  try {
    root = fs.realpathSync(root);
  } catch {
    throw new Error("Unknown skill.");
  }
  const abs = path.resolve(root, rel);
  if (!inside(root, abs)) throw new Error("That file path is not available.");
  let real = abs;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw new Error("That file was not found in the package.");
  }
  if (!inside(root, real)) throw new Error("That file path is not available.");
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error("That file was not found in the package.");
  const raw = fs.readFileSync(real);
  if (raw.includes(0)) {
    return { path: rel, content: "This file is not shown as text.", truncated: false, executable: false, inert: isInert(rel), bytes: stat.size };
  }
  const text = raw.toString("utf8");
  const truncated = text.length > TEXT_LIMIT;
  return {
    path: rel,
    content: truncated ? text.slice(0, TEXT_LIMIT) : text,
    truncated,
    executable: false,
    inert: isInert(rel),
    bytes: stat.size,
  };
}

export function skillDetail(id: string) {
  const skill = findSkill(id);
  if (!skill) return null;
  const summary = summarizeSkill(skill);
  const markdown = readInstructions(skill);
  const report = readSkillQualityReport();
  const duplicates = (report?.duplicates ?? [])
    .filter((pair) => pair.leftId === id || pair.rightId === id)
    .map((pair) => {
      const left = pair.leftId === id;
      return {
        decision: pair.decision as DuplicateDecision,
        otherId: left ? pair.rightId : pair.leftId,
        otherName: left ? pair.rightName : pair.leftName,
        reason: pair.reason,
      };
    });
  const relatedIds = skill.metadata.relatedSkillIds ?? [];
  const all = skillRegistry.list();
  const related = relatedIds.map((relatedId) => {
    const match = all.find((item) => item.id === relatedId || item.metadata.slug === relatedId);
    return match ? { id: match.id, name: match.name, category: match.metadata.category || match.category } : { id: relatedId, name: relatedId, category: "" };
  });
  const unresolvedNames = new Set(summary.unresolvedTools.map((tool) => tool.name));
  const required = summary.requiredTools.filter((name) => !unresolvedNames.has(name)).map((name) => toolView(name, "required"));
  const optional = summary.optionalTools.filter((name) => !unresolvedNames.has(name)).map((name) => toolView(name, "optional"));
  const unresolved = summary.unresolvedTools.map((tool) => toolView(tool.name, "unresolved"));
  const origin = skill.metadata.origin
    ? {
      repository: skill.metadata.origin.repository,
      path: skill.metadata.origin.path,
      author: skill.metadata.origin.author,
      license: skill.metadata.origin.license,
      version: skill.metadata.origin.version,
      importedAt: skill.metadata.origin.importedAt,
    }
    : null;
  return {
    ...summary,
    whenToUse: whenToUse(skill.description, markdown),
    taskDomains: skill.metadata.taskDomains ?? [],
    runModes: skill.metadata.runModes ?? [],
    validationRule: skill.metadata.validation?.rule || skill.validation || "",
    permissions: skill.metadata.permissionsRequired ?? [],
    origin,
    certificationBlockers: skill.metadata.certificationBlockers ?? [],
    trusted: skill.metadata.trusted,
    files: listSkillFiles(id),
    tools: { required, optional, unresolved },
    related,
    duplicates,
    usage: null,
    successRate: null,
    lastUsed: null,
  };
}

export function qualityReportView() {
  const report = readSkillQualityReport();
  if (!report) return null;
  return {
    generatedAt: report.generatedAt,
    totalChecked: report.totalChecked,
    approved: report.approved,
    needsRevision: report.needsRevision,
    disabled: report.disabled,
    native: report.native,
    imported: report.imported,
    brokenReferences: report.brokenReferences,
    providerWording: report.providerWording,
    unresolvedToolAssumptions: report.unresolvedToolAssumptions,
    duplicates: report.duplicates,
    safetyViolations: report.safetyViolations,
    conflicts: report.conflicts,
    disabledSkills: (report.skills ?? [])
      .filter((skill) => skill.qualityStatus === "disabled")
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        category: skill.category,
        source: skill.source,
        issues: (skill.issues ?? []).filter((issue) => issue.severity === "disable").map((issue) => ({ code: issue.code, detail: issue.detail })),
      })),
  };
}
