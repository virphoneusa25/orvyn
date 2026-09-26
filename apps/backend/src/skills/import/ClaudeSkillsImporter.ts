import * as fs from "fs";
import * as path from "path";
import { SkillLoader, builtinSkillsRoot } from "../SkillLoader";
import type { CertificationStatus, SkillMetadata, UnresolvedTool } from "../types";
import { registeredToolNames } from "../registeredToolNames";
import { parseExternalSkill } from "./ExternalSkillParser";
import { buildSkillProvenance, licenseLabel } from "./SkillProvenance";
import { mapExternalTool } from "./toolMap";
import { reviewScript } from "./scriptReview";

export const CLAUDE_SKILLS_REPOSITORY = "https://github.com/alirezarezvani/claude-skills";
export const CLAUDE_SKILLS_IMPORTED_AT = "2026-09-26T17:30:00.000Z";

const RESERVED_PROMPTS = [
  "generate a virphone logo in png format",
  "fix the failing tests",
  "the dashboard layout overflows",
  "what time is it?",
  "inspect this application, determine how it is built and configured, fix the startup failure, build it, run it, and verify it.",
  "diagnose a freeswitch sip call that rings but drops at answer.",
];

/** Extra triggers for skills whose own wording matches a real ORVYN task. */
const EXTRA_TRIGGERS: Record<string, string[]> = {
  "engineering-team/skills/code-reviewer": ["typescript api"],
  "engineering-team/playwright-pro/skills/pw-review": ["playwright-style browser checks"],
  "engineering/terraform-patterns/skills/terraform-patterns": ["terraform configuration"],
  "research/research/skills/research": ["technical topic"],
  "research/deep-research/skills/deep-research": ["compare the approaches"],
};

export type DuplicateDecision = "MERGE" | "SPECIALIZE" | "KEEP_EXISTING";

export interface ClaudeSkillManifestEntry {
  upstreamPath: string;
  name: string;
  category: string;
  license: string;
  certificationStatus: CertificationStatus;
  duplicateOf: string | null;
  duplicateDecision: DuplicateDecision | null;
  unsupportedCapabilities: string[];
  scriptCount: number;
  referenceCount: number;
  templateCount: number;
  securityReviewRequired: boolean;
  active: boolean;
  orvynId: string | null;
  slug: string | null;
}

export interface ClaudeSkillImportReport {
  discovered: number;
  imported: number;
  certified: number;
  partiallySupported: number;
  blocked: number;
  merged: number;
  specialized: number;
  keptExisting: number;
  active: number;
  inactive: number;
  entries: ClaudeSkillManifestEntry[];
}

export interface ImportClaudeSkillsInput {
  snapshotDir: string;
  outputDir: string;
  builtinRoot?: string;
  knownTools?: Set<string>;
  importedAt?: string;
}

interface DiscoveredSkill {
  dir: string;
  upstreamPath: string;
}

interface BuiltinRef {
  id: string;
  name: string;
  slug: string;
  dir: string;
}

function walkSkillFiles(root: string): DiscoveredSkill[] {
  const seen = new Set<string>();
  const found: DiscoveredSkill[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "__pycache__") continue;
      const abs = path.join(dir, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(abs);
        continue;
      }
      if (entry.name !== "SKILL.md") continue;
      let real = abs;
      try {
        real = fs.realpathSync(abs);
      } catch {
        continue;
      }
      if (!real.startsWith(path.resolve(root) + path.sep) && real !== path.resolve(root)) continue;
      if (seen.has(real)) continue;
      seen.add(real);
      const skillDir = path.dirname(real);
      const upstreamPath = path.relative(path.resolve(root), skillDir).split(path.sep).join("/");
      if (upstreamPath.startsWith("..")) continue;
      found.push({ dir: skillDir, upstreamPath });
    }
  };
  walk(root);
  return found.sort((a, b) => a.upstreamPath.localeCompare(b.upstreamPath));
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function safeTriggers(name: string, upstreamPath: string): string[] {
  const candidates = [name.toLowerCase().trim(), ...(EXTRA_TRIGGERS[upstreamPath] ?? [])];
  const out: string[] = [];
  for (const candidate of candidates) {
    const trigger = candidate.trim().toLowerCase();
    if (trigger.length < 8) continue;
    if (RESERVED_PROMPTS.some((prompt) => prompt.includes(trigger))) continue;
    if (!out.includes(trigger)) out.push(trigger);
  }
  if (out.length === 0) {
    const fallback = `${name.toLowerCase().trim()} skill`.trim();
    out.push(RESERVED_PROMPTS.some((prompt) => prompt.includes(fallback)) ? `imported ${fallback}` : fallback);
  }
  return out;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []));
}

function nestedString(raw: Record<string, unknown>, key: string): string {
  const metadata = raw.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return "";
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

function copyInertTree(sourceDir: string, destDir: string): { scripts: string[]; references: string[]; templates: string[]; assets: string[] } {
  const scripts: string[] = [];
  const references: string[] = [];
  const templates: string[] = [];
  const assets: string[] = [];
  const walk = (current: string, rel: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "__pycache__" || entry.name === ".git") continue;
      const abs = path.join(current, entry.name);
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(abs, child);
        continue;
      }
      if (!stat.isFile()) continue;
      if (entry.name === "SKILL.md" && rel === "") continue;
      const dest = path.join(destDir, ...child.split("/"));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(abs, dest);
      fs.chmodSync(dest, 0o644);
      if (child.startsWith("scripts/")) scripts.push(child);
      if (child.startsWith("references/")) references.push(child);
      if (child.startsWith("templates/")) templates.push(child);
      if (child.startsWith("assets/")) assets.push(child);
    }
  };
  walk(sourceDir, "");
  return { scripts, references, templates, assets };
}

function mandatoryExternal(text: string): string | null {
  if (/BROWSERSTACK_(USERNAME|ACCESS_KEY)/.test(text) && /browserstack/i.test(text.slice(0, 500))) return "BrowserStack cloud grid";
  if (/TESTRAIL_API_KEY/.test(text) && /testrail/i.test(text.slice(0, 400))) return "TestRail API";
  const requiredMcp = text.match(/requires[^.\n]{0,80}\bMCP\b[^.\n]{0,80}/i);
  if (requiredMcp && !/optional/i.test(requiredMcp[0])) return requiredMcp[0].trim();
  return null;
}

function optionalMcpNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/\b([A-Z][A-Za-z0-9]+) MCP\b/g)) {
    const window = text.slice(Math.max(0, match.index! - 80), match.index! + match[0].length + 40);
    if (/optional/i.test(window)) names.add(match[1]);
  }
  if (/optional[^.\n]{0,40}\bMCP\b/i.test(text)) names.add("optional MCP");
  return [...names];
}

function adaptMarkdown(original: string, steps: string[]): string {
  const body = original
    .split("Claude Code").join("ORVYN")
    .split("Claude.ai").join("ORVYN");
  return `${body.trimEnd()}\n\n<!-- ORVYN-ADAPTED-STEPS -->\n\n${steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n`;
}

function overlapKind(builtinName: string, upstreamName: string, builtinSlug: string, upstreamSlug: string): "exact" | "narrower" | null {
  if (builtinSlug === upstreamSlug || normalizeName(builtinName) === normalizeName(upstreamName)) return "exact";
  const builtin = normalizeName(builtinName);
  const upstream = normalizeName(upstreamName);
  if (builtin.length > 8 && upstream.includes(builtin) && upstream !== builtin) return "narrower";
  return null;
}

export function importClaudeSkills(input: ImportClaudeSkillsInput): ClaudeSkillImportReport {
  const known = input.knownTools ?? registeredToolNames();
  const importedAt = input.importedAt ?? CLAUDE_SKILLS_IMPORTED_AT;
  const builtinRoot = input.builtinRoot ?? builtinSkillsRoot();
  const builtins = new SkillLoader(builtinRoot).load().skills.map((skill): BuiltinRef => ({
    id: skill.id,
    name: skill.name,
    slug: skill.metadata.slug,
    dir: skill.dir,
  }));
  const discovered = walkSkillFiles(input.snapshotDir);
  fs.rmSync(path.join(input.outputDir, "skills"), { recursive: true, force: true });
  fs.mkdirSync(path.join(input.outputDir, "skills"), { recursive: true });
  const licenseSrc = path.join(input.snapshotDir, "LICENSE");
  if (fs.existsSync(licenseSrc)) {
    fs.copyFileSync(licenseSrc, path.join(input.outputDir, "UPSTREAM_LICENSE"));
    fs.chmodSync(path.join(input.outputDir, "UPSTREAM_LICENSE"), 0o644);
  }

  const usedSlugs = new Set<string>();
  const entries: ClaudeSkillManifestEntry[] = [];
  const planned: { entry: ClaudeSkillManifestEntry; metadata: SkillMetadata; markdown: string; sourceDir: string }[] = [];

  for (const skill of discovered) {
    let parsed: ReturnType<typeof parseExternalSkill> | null = null;
    let parseError = "";
    try {
      parsed = parseExternalSkill(skill.dir);
    } catch (err) {
      parseError = err instanceof Error ? err.message : "Could not read this skill.";
    }
    const name = parsed?.frontmatter.name ?? "";
    const description = parsed?.frontmatter.description ?? "";
    const category = parsed?.frontmatter.category || nestedString(parsed?.raw ?? {}, "category") || skill.upstreamPath.split("/")[0] || "Imported";
    const license = licenseLabel(parsed?.frontmatter.license || "MIT", parsed?.licenseFiles ?? ["LICENSE"]);
    if (!parsed || !name || !description) {
      entries.push({
        upstreamPath: skill.upstreamPath,
        name: name || path.basename(skill.dir),
        category,
        license,
        certificationStatus: "blocked",
        duplicateOf: null,
        duplicateDecision: null,
        unsupportedCapabilities: [parseError || "SKILL.md is missing a name or description."],
        scriptCount: 0,
        referenceCount: 0,
        templateCount: 0,
        securityReviewRequired: false,
        active: false,
        orvynId: null,
        slug: null,
      });
      continue;
    }

    const baseSlug = slugify(name) || "imported-skill";
    let slug = baseSlug;
    let suffix = 2;
    while (usedSlugs.has(slug)) {
      slug = `${baseSlug}-${suffix}`;
      suffix += 1;
    }
    usedSlugs.add(slug);

    const requiredNames = [...parsed.frontmatter.requiredToolNames];
    const optionalNames = [
      ...parsed.frontmatter.optionalToolNames,
      ...stringList(parsed.raw.compatible_tools),
      ...stringList(parsed.raw["allowed-tools"]),
    ];
    const unresolved: UnresolvedTool[] = [];
    const requiredTools: string[] = [];
    const optionalTools: string[] = [];
    const seenTools = new Set<string>();
    const take = (toolName: string, requirement: "required" | "optional") => {
      if (seenTools.has(toolName)) return;
      seenTools.add(toolName);
      const mapped = mapExternalTool(toolName, known);
      if (!mapped) {
        unresolved.push({ name: toolName, requirement });
        return;
      }
      if (requirement === "required") requiredTools.push(mapped);
      else if (!requiredTools.includes(mapped)) optionalTools.push(mapped);
    };
    for (const toolName of requiredNames) take(toolName, "required");
    for (const toolName of optionalNames) take(toolName, "optional");

    const original = parsed.rawMarkdown;
    const external = mandatoryExternal(original);
    const optionalMcp = optionalMcpNames(original);
    const reviews = parsed.scripts.map((rel) => reviewScript(path.join(skill.dir, ...rel.split("/")), rel));
    const highRisk = reviews.filter((review) => review.highRisk);
    const unsupported = [
      ...unresolved.map((tool) => `${tool.requirement} tool ${tool.name}`),
      ...optionalMcp.map((item) => `optional ${item}`),
      ...(external ? [`required integration ${external}`] : []),
    ];
    const requiredUnresolved = unresolved.filter((tool) => tool.requirement === "required");
    let certificationStatus: CertificationStatus = "certified";
    const blockers: string[] = [];
    if (external || requiredUnresolved.length > 0) {
      certificationStatus = "blocked";
      if (external) blockers.push(`Core capability depends on ${external}, which ORVYN cannot provide.`);
      for (const tool of requiredUnresolved) blockers.push(`Required capability "${tool.name}" has no ORVYN tool.`);
    } else if (optionalMcp.length > 0 || unresolved.some((tool) => tool.requirement === "optional") || highRisk.length > 0) {
      certificationStatus = "partially_supported";
      if (optionalMcp.length > 0) blockers.push(`Optional MCP capabilities are omitted: ${optionalMcp.join(", ")}.`);
      for (const tool of unresolved) {
        if (tool.requirement === "optional") blockers.push(`Optional capability "${tool.name}" has no ORVYN tool and is omitted.`);
      }
      if (highRisk.length > 0) blockers.push(`High-risk scripts stay disabled: ${highRisk.map((review) => review.path).join(", ")}.`);
    }

    const exact = builtins.find((builtin) => overlapKind(builtin.name, name, builtin.slug, slug) === "exact");
    const narrower = exact ? null : builtins.find((builtin) => overlapKind(builtin.name, name, builtin.slug, slug) === "narrower");
    let duplicateOf: string | null = null;
    let duplicateDecision: DuplicateDecision | null = null;
    if (exact) {
      duplicateOf = exact.id;
      const hasExtra = parsed.references.length > 0 || parsed.templates.length > 0 || original.length > 1500;
      duplicateDecision = hasExtra ? "MERGE" : "KEEP_EXISTING";
    } else if (narrower) {
      duplicateOf = narrower.id;
      duplicateDecision = "SPECIALIZE";
    }

    const active = certificationStatus !== "blocked" && duplicateDecision !== "KEEP_EXISTING" && duplicateDecision !== "MERGE";
    const relatedNames = stringList(parsed.raw.skills);
    const browserSkill = /playwright|browser/i.test(`${name} ${skill.upstreamPath}`);
    const browserTools = ["browser_open", "browser_navigate", "browser_click", "browser_screenshot"].filter((tool) => known.has(tool));
    if (browserSkill) {
      for (const tool of browserTools) {
        if (!requiredTools.includes(tool) && !optionalTools.includes(tool)) optionalTools.push(tool);
      }
    }
    const researchTools = ["web_search", "fetch_url"].filter((tool) => known.has(tool));
    if (/research/i.test(category) || /research/i.test(name)) {
      for (const tool of researchTools) {
        if (!requiredTools.includes(tool) && !optionalTools.includes(tool)) optionalTools.push(tool);
      }
    }

    const toolList = [...requiredTools, ...optionalTools];
    const steps = [
      "Follow the domain workflow above. Read a file under references/, templates/, or assets/ only when the workflow names that file. Do not load every reference into the prompt.",
      toolList.length > 0
        ? `Use these ORVYN tools when the workflow needs them: ${toolList.join(", ")}. Do not call a tool that is not registered.`
        : "Use read_file when the workflow names a file. Do not invent tools.",
      browserSkill
        ? "Use the existing ORVYN Browser session from browser_open. Do not create a second browser. Playwright-style checks run through browser_navigate, browser_click, and browser_screenshot."
        : "ORVYN has no Claude slash-command runner. Follow the workflow with the ORVYN tools named above.",
      reviews.length === 0
        ? "This skill does not ship a helper script."
        : `Do not execute scripts directly from this skill. ${reviews.filter((review) => !review.highRisk).map((review) => review.path).join(", ") || "No script"} may run only through the terminal tool, which uses ToolGateway, PermissionEngine, and ExecutionProvider. High-risk scripts stay disabled: ${highRisk.map((review) => review.path).join(", ") || "none"}.`,
      unsupported.length > 0
        ? `Omit unsupported capabilities: ${unsupported.join("; ")}.`
        : "Every declared capability used above maps to an ORVYN tool.",
      relatedNames.length > 0
        ? `Related upstream skills stay inactive unless the request names them: ${relatedNames.join(", ")}.`
        : "Do not activate unrelated skills for this workflow.",
    ];

    const metadata: SkillMetadata = {
      id: `skill_cs_${slug.replace(/-/g, "_")}`,
      slug,
      name,
      version: parsed.frontmatter.version || nestedString(parsed.raw, "version") || "0.0.0",
      description,
      category,
      publisher: parsed.frontmatter.author || nestedString(parsed.raw, "author") || "Alireza Rezvani",
      source: "imported",
      builtIn: false,
      trusted: active,
      triggers: safeTriggers(name, skill.upstreamPath),
      taskDomains: [category.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "imported"],
      runModes: ["agent", "code", "server", "auto"],
      requiredTools,
      optionalTools,
      permissionsRequired: toolList.map((id) => ({
        id,
        reason: "Mapped from the upstream skill onto a registered ORVYN tool.",
      })),
      validation: {
        rule: certificationStatus === "blocked"
          ? "Blocked. Do not run this skill."
          : "The adapted workflow uses registered ORVYN tools, leaves unresolved optional capabilities unused, and does not execute imported scripts directly.",
      },
      tags: ["imported", "claude-skills", "third-party"],
      scope: "personal",
      origin: buildSkillProvenance({
        repository: CLAUDE_SKILLS_REPOSITORY,
        path: skill.upstreamPath,
        license,
        author: parsed.frontmatter.author || nestedString(parsed.raw, "author") || "Alireza Rezvani",
        version: parsed.frontmatter.version || nestedString(parsed.raw, "version"),
        importedAt,
      }),
      certificationStatus,
      unresolvedTools: unresolved,
      certificationBlockers: blockers,
      relatedSkillIds: [],
    };

    const entry: ClaudeSkillManifestEntry = {
      upstreamPath: skill.upstreamPath,
      name,
      category,
      license,
      certificationStatus,
      duplicateOf,
      duplicateDecision,
      unsupportedCapabilities: unsupported,
      scriptCount: reviews.length,
      referenceCount: parsed.references.length,
      templateCount: parsed.templates.length,
      securityReviewRequired: reviews.length > 0,
      active,
      orvynId: active || certificationStatus === "blocked" ? metadata.id : null,
      slug: active || certificationStatus === "blocked" ? slug : null,
    };
    entries.push(entry);
    if (duplicateDecision === "MERGE" && exact) mergeUpstream(exact, skill.dir, name, skill.upstreamPath, parsed.references, parsed.templates);
    if (duplicateDecision === "KEEP_EXISTING" || duplicateDecision === "MERGE") continue;
    planned.push({ entry, metadata, markdown: adaptMarkdown(original, steps), sourceDir: skill.dir });
  }

  const idByName = new Map(planned.map((item) => [normalizeName(item.metadata.name), item.metadata.id]));
  for (const item of planned) {
    const related = stringList((() => {
      try {
        return parseExternalSkill(item.sourceDir).raw.skills;
      } catch {
        return [];
      }
    })());
    item.metadata.relatedSkillIds = related
      .map((relatedName) => idByName.get(normalizeName(relatedName)))
      .filter((id): id is string => Boolean(id) && id !== item.metadata.id);
    const packageDir = path.join(input.outputDir, "skills", item.metadata.slug);
    fs.mkdirSync(packageDir, { recursive: true });
    copyInertTree(item.sourceDir, packageDir);
    fs.writeFileSync(path.join(packageDir, "SKILL.md"), item.markdown);
    fs.chmodSync(path.join(packageDir, "SKILL.md"), 0o644);
    fs.writeFileSync(path.join(packageDir, "skill.json"), `${JSON.stringify(item.metadata, null, 2)}\n`);
  }

  const report: ClaudeSkillImportReport = {
    discovered: discovered.length,
    imported: entries.filter((entry) => entry.slug).length,
    certified: entries.filter((entry) => entry.certificationStatus === "certified").length,
    partiallySupported: entries.filter((entry) => entry.certificationStatus === "partially_supported").length,
    blocked: entries.filter((entry) => entry.certificationStatus === "blocked").length,
    merged: entries.filter((entry) => entry.duplicateDecision === "MERGE").length,
    specialized: entries.filter((entry) => entry.duplicateDecision === "SPECIALIZE").length,
    keptExisting: entries.filter((entry) => entry.duplicateDecision === "KEEP_EXISTING").length,
    active: entries.filter((entry) => entry.active).length,
    inactive: entries.filter((entry) => !entry.active).length,
    entries,
  };
  fs.writeFileSync(path.join(input.outputDir, "import-manifest.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function mergeUpstream(builtin: BuiltinRef, sourceDir: string, name: string, upstreamPath: string, references: string[], templates: string[]): void {
  const destRoot = path.join(builtin.dir, "upstream-references", slugify(name) || "upstream");
  for (const rel of [...references, ...templates]) {
    const from = path.join(sourceDir, ...rel.split("/"));
    if (!fs.existsSync(from) || !fs.statSync(from).isFile()) continue;
    const dest = path.join(destRoot, ...rel.split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(from, dest);
    fs.chmodSync(dest, 0o644);
  }
  const skillPath = path.join(builtin.dir, "SKILL.md");
  const marker = `<!-- upstream-claude-skills:${upstreamPath} -->`;
  const current = fs.readFileSync(skillPath, "utf8");
  if (current.includes(marker)) return;
  fs.appendFileSync(skillPath, `\n${marker}\n\nUpstream notes from claude-skills: ${name} (${upstreamPath}) overlaps this skill. Additional references, when present, are in upstream-references/. Use them only when the task needs that detail.\n`);
}
