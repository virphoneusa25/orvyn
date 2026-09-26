import * as fs from "fs";
import * as path from "path";
import { builtinSkillsRoot } from "../SkillLoader";
import type { RankableSkill } from "../SkillRanker";
import { classifyDuplicatePairs, detectSkillConflicts, duplicateDisableIds, policyOverrides, type DuplicatePair, type SkillConflict, type PolicyOverride } from "./SkillConflictDetector";
import { normalizeSkillInstructions } from "./SkillInstructionNormalizer";
import { brokenAssetPaths, evaluateSkill, type QualityIssue, type QualityStatus, type SkillQuality } from "./SkillQualityEvaluator";

export interface QualityCounts {
  total: number;
  approved: number;
  needsRevision: number;
  disabled: number;
}

export interface SkillQualityReportData {
  generatedAt: string;
  totalChecked: number;
  approved: number;
  needsRevision: number;
  disabled: number;
  native: QualityCounts;
  imported: QualityCounts;
  brokenReferences: Array<{ id: string; name: string; paths: string[] }>;
  providerWording: Array<{ id: string; name: string; changes: number }>;
  unresolvedToolAssumptions: Array<{ id: string; name: string; detail: string }>;
  conflicts: SkillConflict[];
  policyOverrides: PolicyOverride[];
  duplicates: DuplicatePair[];
  safetyViolations: Array<{ id: string; name: string; code: string; detail: string }>;
  normalizations: Array<{ id: string; name: string; changes: number }>;
  manualReview: Array<{ id: string; name: string; reason: string }>;
  skills: SkillQuality[];
}

function counts(skills: SkillQuality[]): QualityCounts {
  return {
    total: skills.length,
    approved: skills.filter((skill) => skill.qualityStatus === "approved").length,
    needsRevision: skills.filter((skill) => skill.qualityStatus === "needs_revision").length,
    disabled: skills.filter((skill) => skill.qualityStatus === "disabled").length,
  };
}

function issue(skill: SkillQuality, code: string): QualityIssue | undefined {
  return skill.issues.find((item) => item.code === code);
}

export function buildSkillQualityReport(skills: RankableSkill[], knownTools?: Set<string>, generatedAt = new Date().toISOString()): SkillQualityReportData {
  const duplicates = classifyDuplicatePairs(skills);
  const disableIds = duplicateDisableIds(duplicates);
  const evaluated = skills.map((skill) => evaluateSkill(skill, {
    knownTools,
    duplicateOf: disableIds.has(skill.id) ? duplicates.find((pair) => pair.rightId === skill.id)?.leftName : undefined,
  }));

  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const brokenReferences = evaluated.flatMap((skill) => {
    const pkg = byId.get(skill.id);
    if (!pkg) return [];
    const paths = brokenAssetPaths(pkg.dir, pkg.instructions || "");
    return paths.length ? [{ id: skill.id, name: skill.name, paths }] : [];
  });

  const providerWording: SkillQualityReportData["providerWording"] = [];
  const normalizations: SkillQualityReportData["normalizations"] = [];
  for (const skill of skills) {
    const normalized = normalizeSkillInstructions(skill.instructions || "");
    if (!normalized.changes.length) continue;
    const row = { id: skill.id, name: skill.name, changes: normalized.changes.length };
    providerWording.push(row);
    normalizations.push(row);
  }

  const unresolvedToolAssumptions = evaluated.flatMap((skill) => skill.issues
    .filter((item) => item.code === "unresolved_tool" || item.code === "unsupported_tool" || item.code === "optional_unresolved_tool")
    .map((item) => ({ id: skill.id, name: skill.name, detail: item.detail })));

  const active = skills.filter((skill) => skill.metadata?.certificationStatus !== "blocked" && skill.enabled !== false);
  const conflicts = detectSkillConflicts(active.map((skill) => ({ id: skill.id, name: skill.name, instructions: skill.instructions || "" })));
  const overrides = policyOverrides(active.map((skill) => ({ id: skill.id, name: skill.name, instructions: skill.instructions || "" })));

  const safetyViolations = evaluated.flatMap((skill) => skill.issues
    .filter((item) => item.severity === "disable" && item.code !== "certification_blocked" && item.code !== "duplicate_package" && item.code !== "missing_required_file")
    .map((item) => ({ id: skill.id, name: skill.name, code: item.code, detail: item.detail })));

  const manualReview: SkillQualityReportData["manualReview"] = [];
  for (const pair of duplicates) {
    if (pair.decision === "MERGE_LATER") {
      manualReview.push({ id: pair.rightId, name: pair.rightName, reason: `${pair.decision}: ${pair.reason}` });
    }
  }
  for (const skill of evaluated) {
    if (issue(skill, "provider_workflow") || issue(skill, "broken_reference")) {
      manualReview.push({ id: skill.id, name: skill.name, reason: skill.issues.filter((item) => item.severity === "revision").map((item) => item.detail).join(" ") });
    }
  }

  const nativeSkills = evaluated.filter((skill) => skill.source === "native");
  const importedSkills = evaluated.filter((skill) => skill.source === "imported");
  const summary = counts(evaluated);
  return {
    generatedAt,
    totalChecked: summary.total,
    approved: summary.approved,
    needsRevision: summary.needsRevision,
    disabled: summary.disabled,
    native: counts(nativeSkills),
    imported: counts(importedSkills),
    brokenReferences,
    providerWording,
    unresolvedToolAssumptions,
    conflicts,
    policyOverrides: overrides,
    duplicates,
    safetyViolations,
    normalizations,
    manualReview,
    skills: evaluated,
  };
}

function list(items: string[], empty: string): string {
  if (!items.length) return empty;
  return items.map((item) => `- ${item}`).join("\n");
}

export function renderQualityMarkdown(report: SkillQualityReportData): string {
  const disabled = report.skills.filter((skill) => skill.qualityStatus === "disabled");
  const revision = report.skills.filter((skill) => skill.qualityStatus === "needs_revision");
  const lines = [
    "# ORVYN skill quality report",
    "",
    "Internal certification review of the active catalog. The review score is for queues and routing tie-breaks. It is not a user-facing intelligence score.",
    "",
    "Original package files, provenance, and license metadata are unchanged. Platform wording is adapted when a selected skill is loaded into context.",
    "",
    "## Summary",
    "",
    `| | Count |`,
    `| --- | ---: |`,
    `| Skills checked | ${report.totalChecked} |`,
    `| Approved | ${report.approved} |`,
    `| Needs revision | ${report.needsRevision} |`,
    `| Disabled | ${report.disabled} |`,
    "",
    "## Native and imported",
    "",
    `| Source | Checked | Approved | Needs revision | Disabled |`,
    `| --- | ---: | ---: | ---: | ---: |`,
    `| Native | ${report.native.total} | ${report.native.approved} | ${report.native.needsRevision} | ${report.native.disabled} |`,
    `| Imported | ${report.imported.total} | ${report.imported.approved} | ${report.imported.needsRevision} | ${report.imported.disabled} |`,
    "",
    "## Disabled",
    "",
    list(disabled.map((skill) => `${skill.id} (${skill.name}): ${skill.issues.filter((item) => item.severity === "disable").map((item) => item.code).join(", ")}`), "None."),
    "",
    "## Needs revision",
    "",
    list(revision.map((skill) => `${skill.id} (${skill.name}): ${skill.issues.filter((item) => item.severity === "revision").map((item) => item.code).join(", ")}`), "None."),
    "",
    "## Broken references",
    "",
    list(report.brokenReferences.map((item) => `${item.id}: ${item.paths.join(", ")}`), "None."),
    "",
    "## Provider-specific wording",
    "",
    `${report.providerWording.length} skills contain Claude Code, Claude.ai, AskUserQuestion, or /cs: commands. Those phrases are rewritten to ORVYN workflows when the skill is loaded. No new tool is introduced.`,
    "",
    list(report.providerWording.map((item) => `${item.id}: ${item.changes} phrase${item.changes === 1 ? "" : "s"}`), "None."),
    "",
    "## Unresolved tool assumptions",
    "",
    list(report.unresolvedToolAssumptions.map((item) => `${item.id}: ${item.detail}`), "None."),
    "",
    "## Conflict pairs",
    "",
    list(report.conflicts.map((item) => `${item.leftName} / ${item.rightName}: ${item.resolution}`), "No opposing instructions were found among skills that can route."),
    "",
    report.policyOverrides.length ? list(report.policyOverrides.map((item) => `${item.skillName}: ${item.policy}`), "") : "",
    "",
    "## Duplicate pairs",
    "",
    list(report.duplicates.map((item) => `${item.decision}: ${item.leftName} / ${item.rightName}. ${item.reason}`), "None."),
    "",
    "Imported security, threat, and audit skills have no native security counterpart, so they are not collapsed into a native skill.",
    "",
    "## Safety violations",
    "",
    list(report.safetyViolations.map((item) => `${item.id} [${item.code}]: ${item.detail}`), "None in the installed catalog."),
    "",
    "## Automatic normalizations",
    "",
    "Applied at context load. Package bytes stay available for audit.",
    "",
    list(report.normalizations.map((item) => `${item.id}: ${item.changes}`), "None."),
    "",
    "## Manual review",
    "",
    list(report.manualReview.map((item) => `${item.id} (${item.name}): ${item.reason}`), "None."),
    "",
  ];
  return lines.filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n");
}

export function qualityReportPath(start = process.cwd()): string {
  return path.join(builtinSkillsRoot(start), "skill-quality-report.json");
}

export function writeSkillQualityReport(report: SkillQualityReportData, markdownPath: string, jsonPath = qualityReportPath()): void {
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  const payload = { ...report, skills: report.skills.map(({ issues, ...skill }) => ({ ...skill, issues })) };
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(markdownPath, renderQualityMarkdown(report));
}

let reportCache: { mtime: number; report: SkillQualityReportData } | null = null;

/** Read the committed quality report. The file is the source of truth for the Skills workspace. */
export function readSkillQualityReport(): SkillQualityReportData | null {
  const file = qualityReportPath();
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (reportCache && reportCache.mtime === mtime) return reportCache.report;
    const report = JSON.parse(fs.readFileSync(file, "utf8")) as SkillQualityReportData;
    reportCache = { mtime, report };
    return report;
  } catch {
    return null;
  }
}

let indexCache: Map<string, { qualityStatus: QualityStatus; qualityScore: number }> | null = null;

/** Read the committed review index. Missing file means no quality stamp. */
export function qualityIndex(): Map<string, { qualityStatus: QualityStatus; qualityScore: number }> {
  if (indexCache) return indexCache;
  const file = qualityReportPath();
  const map = new Map<string, { qualityStatus: QualityStatus; qualityScore: number }>();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { skills?: SkillQuality[] };
    for (const skill of parsed.skills ?? []) {
      if (skill?.id && skill.qualityStatus) map.set(skill.id, { qualityStatus: skill.qualityStatus, qualityScore: skill.qualityScore ?? 0 });
    }
  } catch {
    // Ranking still works before the report exists.
  }
  indexCache = map;
  return map;
}

export function resetQualityIndexCache(): void {
  indexCache = null;
}
