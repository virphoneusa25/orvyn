import * as fs from "fs";
import * as path from "path";
import type { RankableSkill } from "../SkillRanker";
import { mapExternalTool } from "../import/toolMap";
import { normalizeSkillInstructions } from "./SkillInstructionNormalizer";
import { instructionStances, policyOverrides } from "./SkillConflictDetector";

export type QualityStatus = "approved" | "needs_revision" | "disabled";

export interface QualityIssue {
  code: string;
  severity: "info" | "revision" | "disable";
  detail: string;
}

export interface SkillQuality {
  id: string;
  name: string;
  slug: string;
  source: "native" | "imported";
  category: string;
  qualityStatus: QualityStatus;
  /** Internal review score for queues and tie-breaks. Not a user-facing rating. */
  qualityScore: number;
  issues: QualityIssue[];
}

const ASSET = /(?:references|templates|scripts)\/[A-Za-z0-9_./+-]+\.[A-Za-z0-9]+/g;
const NEGATIVE = /\b(do not|don't|dont|never|must not|cannot|can't|avoid)\b/i;

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?\n])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
}

function violating(text: string, pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const sentence of sentences(text)) {
    const index = sentence.search(pattern);
    if (index < 0) continue;
    if (NEGATIVE.test(sentence.slice(0, index))) continue;
    hits.push(sentence.slice(0, 220));
  }
  return hits;
}

export function referencedAssets(instructions: string): string[] {
  const found = new Set<string>();
  for (const match of instructions.match(ASSET) ?? []) {
    if (match.includes("*") || match.includes("<") || match.includes(">")) continue;
    found.add(match);
  }
  return [...found];
}

export function brokenAssetPaths(dir: string, instructions: string): string[] {
  if (!dir) return [];
  return referencedAssets(instructions).filter((rel) => {
    try {
      return !fs.existsSync(path.join(dir, rel));
    } catch {
      return true;
    }
  });
}

function isNative(skill: RankableSkill): boolean {
  if (skill.builtin || skill.metadata?.builtIn) return true;
  const source = skill.metadata?.source || skill.source;
  return source === "builtin" || source === "built-in";
}

function statusFrom(issues: QualityIssue[]): QualityStatus {
  if (issues.some((issue) => issue.severity === "disable")) return "disabled";
  if (issues.some((issue) => issue.severity === "revision")) return "needs_revision";
  return "approved";
}

function scoreFrom(issues: QualityIssue[]): number {
  let score = 100;
  for (const issue of issues) {
    if (issue.severity === "disable") score -= 40;
    else if (issue.severity === "revision") score -= 12;
    else score -= 2;
  }
  if (score < 0) return 0;
  if (score > 100) return 100;
  return score;
}

export interface EvaluateSkillInput {
  knownTools?: Set<string>;
  duplicateOf?: string;
}

/** Classify one skill. Minor wording does not disable it. */
export function evaluateSkill(skill: RankableSkill, input: EvaluateSkillInput = {}): SkillQuality {
  const issues: QualityIssue[] = [];
  const instructions = skill.instructions || "";
  const description = (skill.description || skill.metadata?.description || "").trim();
  const validation = (skill.validation || skill.metadata?.validation?.rule || "").trim();
  const triggers = skill.metadata?.triggers?.length ? skill.metadata.triggers : (skill.trigger || "").split(",").map((part) => part.trim()).filter(Boolean);

  if (skill.metadata?.certificationStatus === "blocked" || (skill.metadata?.source === "imported" && skill.metadata.trusted === false)) {
    issues.push({ code: "certification_blocked", severity: "disable", detail: "Certification is blocked, so the skill is not routed." });
  }
  if (input.duplicateOf) {
    issues.push({ code: "duplicate_package", severity: "disable", detail: `Same workflow as ${input.duplicateOf}. The package stays installed and is not routed.` });
  }

  if (description.length < 24) {
    issues.push({ code: "unclear_purpose", severity: "revision", detail: "The description does not state a clear purpose." });
  }
  if (!triggers.some((trigger) => trigger.trim().length >= 8)) {
    issues.push({ code: "weak_triggers", severity: "revision", detail: "No trigger is specific enough to route this skill on its own." });
  }
  const actionable = skill.steps.length > 0 || /\b(inspect|read|edit|run|check|verify|open|compare|diagnose)\b/i.test(instructions);
  if (instructions.trim().length < 80 || !actionable) {
    issues.push({ code: "thin_instructions", severity: "revision", detail: "The playbook does not give an actionable workflow." });
  }
  if (!validation) {
    issues.push({ code: "missing_validation", severity: "revision", detail: "The completion gate is empty." });
  }

  if (skill.dir) {
    for (const file of ["skill.json", "SKILL.md"]) {
      if (!fs.existsSync(path.join(skill.dir, file))) {
        issues.push({ code: "missing_required_file", severity: "disable", detail: `${file} is missing from the package.` });
      }
    }
  }

  const missing = brokenAssetPaths(skill.dir, instructions);
  if (missing.length) {
    const remainder = instructions.replace(ASSET, "").replace(/[^a-z]/gi, "");
    const core = remainder.length < 40;
    issues.push({
      code: "broken_reference",
      severity: core ? "disable" : "revision",
      detail: core
        ? `Core workflow file is missing: ${missing.join(", ")}`
        : `Referenced file is missing: ${missing.join(", ")}`,
    });
  }

  const known = input.knownTools;
  for (const tool of skill.metadata?.unresolvedTools ?? []) {
    if (tool.requirement === "required") {
      issues.push({ code: "unresolved_tool", severity: "revision", detail: `Required tool has no ORVYN equivalent: ${tool.name}` });
    } else {
      issues.push({ code: "optional_unresolved_tool", severity: "info", detail: `Optional tool is not available: ${tool.name}` });
    }
  }
  if (known) {
    for (const name of [...(skill.metadata?.requiredTools ?? []), ...(skill.requiredTools ?? [])]) {
      if (!known.has(name) && !mapExternalTool(name, known)) {
        issues.push({ code: "unsupported_tool", severity: "revision", detail: `Required tool is not registered: ${name}` });
      }
    }
  }

  const normalized = normalizeSkillInstructions(instructions);
  if (normalized.changes.length) {
    issues.push({
      code: "provider_wording",
      severity: "info",
      detail: `Adapted ${normalized.changes.length} platform phrase${normalized.changes.length === 1 ? "" : "s"} when the skill is loaded.`,
    });
  }
  const slashOnly = (instructions.match(/\/cs:[a-z0-9-]+/gi) ?? []).length;
  if (slashOnly >= 4 && instructions.length < 500) {
    issues.push({ code: "provider_workflow", severity: "revision", detail: "The workflow is mostly Claude slash commands and has no ORVYN command runner." });
  }

  const safetyPatterns: Array<[string, RegExp]> = [
    ["bypass_gateway", /\b(bypass approval|bypass (the )?(toolgateway|gateway)|run shell commands directly|execute (imported )?scripts directly)\b/i],
    ["expose_secrets", /\b(expose|print|reveal|dump) (the )?(vault )?(secret|credential|api key|private key)\b/i],
    ["invent_credentials", /\binvent (a |the )?(credential|password|api key)\b/i],
    ["pretend_tool", /\b(pretend|claim) (that )?(the |a )?tool (ran|succeeded)\b/i],
    ["false_completion", /\b(claim (it |that )?(passed|done|complete)|tests passed) without\b/i],
    ["assume_success", /\bassume success\b/i],
    ["skip_verification", /\bskip (the )?tests\b/i],
    ["assume_ssh", /\bassume (an? |the )?ssh (server|resource|host) exists\b/i],
    ["destructive", /\b(rm\s+-rf\s+\/(?:\s|$)|drop\s+database|iptables\s+-F)\b/i],
  ];
  for (const [code, pattern] of safetyPatterns) {
    const hits = violating(instructions, pattern).filter((sentence) => {
      if (code !== "destructive") return true;
      return !/\b(require|requires|required|approval|authority|destructive|forbidden|do not|don't|never)\b/i.test(sentence);
    });
    if (!hits.length) continue;
    const disable = code === "bypass_gateway" || code === "expose_secrets" || code === "invent_credentials" || code === "destructive" || code === "pretend_tool";
    issues.push({
      code,
      severity: disable ? "disable" : "revision",
      detail: hits[0],
    });
  }

  const stances = instructionStances(instructions);
  if (stances.bypassApproval && stances.approvalRequired) {
    issues.push({ code: "contradictory_permissions", severity: "disable", detail: "The playbook both requires approval and tells the agent to bypass it." });
  }
  if (policyOverrides([{ id: skill.id, name: skill.name, instructions }]).length && !issues.some((issue) => issue.code === "bypass_gateway" || issue.code === "assume_success" || issue.code === "skip_verification")) {
    issues.push({ code: "policy_conflict", severity: "revision", detail: "An instruction conflicts with ORVYN safety or completion rules." });
  }

  return {
    id: skill.id,
    name: skill.name,
    slug: skill.metadata?.slug || "",
    source: isNative(skill) ? "native" : "imported",
    category: skill.category || skill.metadata?.category || "",
    qualityStatus: statusFrom(issues),
    qualityScore: scoreFrom(issues),
    issues,
  };
}
