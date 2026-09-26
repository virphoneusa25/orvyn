import type { RankableSkill } from "../SkillRanker";

export const POLICY_PRECEDENCE = [
  "ORVYN safety and permission policy",
  "ORVYN runtime truth and completion rules",
  "task-specific specialist skill",
  "general workflow skill",
  "optional imported preference",
] as const;

export type DuplicateDecision = "KEEP_BOTH" | "MERGE_LATER" | "PREFER_NATIVE" | "PREFER_IMPORTED" | "DISABLE_DUPLICATE";

export interface InstructionStances {
  editImmediately: boolean;
  inspectFirst: boolean;
  skipTests: boolean;
  verificationRequired: boolean;
  autoRestart: boolean;
  approvalRequired: boolean;
  assumeSuccess: boolean;
  bypassApproval: boolean;
  directExecution: boolean;
}

export interface PolicyOverride {
  skillId: string;
  skillName: string;
  level: 1 | 2;
  policy: string;
  overridden: string;
}

export interface SkillConflict {
  leftId: string;
  leftName: string;
  rightId: string;
  rightName: string;
  level: 1 | 2;
  winner: "orvyn-policy";
  resolution: string;
}

export interface DuplicatePair {
  leftId: string;
  leftName: string;
  rightId: string;
  rightName: string;
  decision: DuplicateDecision;
  reason: string;
}

const NEGATIVE = /\b(do not|don't|dont|never|must not|cannot|can't|avoid)\b/i;

function stance(text: string, pattern: RegExp): boolean {
  const sentences = text.split(/(?<=[.!?\n])\s+/);
  for (const sentence of sentences) {
    const index = sentence.search(pattern);
    if (index < 0) continue;
    const before = sentence.slice(0, index);
    if (NEGATIVE.test(before)) continue;
    return true;
  }
  return false;
}

export function instructionStances(text: string): InstructionStances {
  return {
    editImmediately: stance(text, /\b(always edit immediately|edit immediately|modify immediately)\b/i),
    inspectFirst: stance(text, /\binspect before (modifying|editing|changing)\b/i),
    skipTests: stance(text, /\bskip (the )?tests( for speed)?\b/i),
    verificationRequired: stance(text, /\b(verification required|run the checks|prove this change|verify the result)\b/i),
    autoRestart: stance(text, /\b(restart (the )?service automatically|always restart)\b/i),
    approvalRequired: stance(text, /\b(mutating actions require approval|require approval|requires approval)\b/i),
    assumeSuccess: stance(text, /\bassume success\b/i),
    bypassApproval: stance(text, /\bbypass approval\b/i),
    directExecution: stance(text, /\b(run|execute) (shell |imported )?commands? directly\b/i) || stance(text, /\bbypass (the )?(toolgateway|gateway)\b/i),
  };
}

function violatesPolicy(stances: InstructionStances): { level: 1 | 2; overridden: string; policy: string } | null {
  if (stances.bypassApproval || stances.directExecution) {
    return {
      level: 1,
      overridden: "bypass approval or run commands outside ToolGateway",
      policy: "Mutating and shell actions go through ToolGateway, PermissionEngine, and ExecutionProvider.",
    };
  }
  if (stances.editImmediately) {
    return {
      level: 1,
      overridden: "always edit immediately",
      policy: "Inspect before modifying. Do not apply an edit before the relevant files have been read.",
    };
  }
  if (stances.autoRestart) {
    return {
      level: 1,
      overridden: "restart service automatically",
      policy: "Mutating actions, including service restarts, require policy approval.",
    };
  }
  if (stances.skipTests || stances.assumeSuccess) {
    return {
      level: 2,
      overridden: stances.assumeSuccess ? "assume success after an edit" : "skip tests",
      policy: "Verification is required. Do not claim completion, a passing test, or a successful edit without tool evidence.",
    };
  }
  return null;
}

export function policyOverrides(skills: Array<{ id: string; name: string; instructions: string }>): PolicyOverride[] {
  const overrides: PolicyOverride[] = [];
  for (const skill of skills) {
    const violation = violatesPolicy(instructionStances(skill.instructions || ""));
    if (!violation) continue;
    overrides.push({ skillId: skill.id, skillName: skill.name, ...violation });
  }
  return overrides;
}

export function detectSkillConflicts(skills: Array<{ id: string; name: string; instructions: string }>): SkillConflict[] {
  const stamped = skills.map((skill) => ({ skill, stances: instructionStances(skill.instructions || "") }));
  const conflicts: SkillConflict[] = [];
  for (let i = 0; i < stamped.length; i++) {
    for (let j = i + 1; j < stamped.length; j++) {
      const left = stamped[i].skill;
      const right = stamped[j].skill;
      const a = stamped[i].stances;
      const b = stamped[j].stances;
      const opposed =
        (a.editImmediately && b.inspectFirst) || (b.editImmediately && a.inspectFirst)
        || (a.skipTests && (b.verificationRequired || b.inspectFirst)) || (b.skipTests && (a.verificationRequired || a.inspectFirst))
        || (a.autoRestart && b.approvalRequired) || (b.autoRestart && a.approvalRequired)
        || (a.assumeSuccess && (b.verificationRequired || b.inspectFirst)) || (b.assumeSuccess && (a.verificationRequired || a.inspectFirst))
        || (a.bypassApproval && b.approvalRequired) || (b.bypassApproval && a.approvalRequired);
      if (!opposed) continue;
      const override = violatesPolicy(a) || violatesPolicy(b);
      if (!override) continue;
      conflicts.push({
        leftId: left.id,
        leftName: left.name,
        rightId: right.id,
        rightName: right.name,
        level: override.level,
        winner: "orvyn-policy",
        resolution: `${POLICY_PRECEDENCE[override.level - 1]} wins. ${override.policy}`,
      });
    }
  }
  return conflicts;
}

/** Short prompt note when a selected skill disagrees with ORVYN policy. Empty when the set is compatible. */
export function precedenceOverlay(skills: Array<{ id: string; name: string; instructions: string }>): string {
  const overrides = policyOverrides(skills);
  if (!overrides.length) return "";
  const lines = overrides.map((item) => `${item.skillName}: ${item.policy}`);
  return ["ORVYN policy precedence:", ...lines].join("\n");
}

function pair(left: RankableSkill, right: RankableSkill, decision: DuplicateDecision, reason: string): DuplicatePair {
  return {
    leftId: left.id,
    leftName: left.name,
    rightId: right.id,
    rightName: right.name,
    decision,
    reason,
  };
}

export function classifyDuplicatePairs(skills: RankableSkill[]): DuplicatePair[] {
  const bySlug = new Map(skills.map((skill) => [skill.metadata?.slug || "", skill]));
  const pairs: DuplicatePair[] = [];
  const seen = new Set<string>();
  const add = (left: RankableSkill | undefined, right: RankableSkill | undefined, decision: DuplicateDecision, reason: string) => {
    if (!left || !right || left.id === right.id) return;
    const key = [left.id, right.id].sort().join("|");
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push(pair(left, right, decision, reason));
  };

  add(bySlug.get("code-review"), bySlug.get("code-reviewer"), "KEEP_BOTH", "Code Review is the general workflow. code-reviewer adds language-specific review depth.");
  add(bySlug.get("web-research"), bySlug.get("deep-research"), "KEEP_BOTH", "Web Research gathers sources. deep-research compares approaches and stays a specialist.");
  add(bySlug.get("technical-research"), bySlug.get("research"), "KEEP_BOTH", "Technical Research is the native research workflow. The imported research skill is a separate method, not a replacement.");
  add(bySlug.get("pricing-strategy"), bySlug.get("pricing-strategist"), "MERGE_LATER", "Both cover SaaS pricing design. Keep pricing-strategy in front until the workflows are merged. Do not delete either package.");
  add(bySlug.get("browser-qa"), bySlug.get("pw-review"), "KEEP_BOTH", "Browser QA is the native page check. pw-review adds Playwright-style depth and must use the existing ORVYN browser session.");
  add(bySlug.get("browser-qa"), bySlug.get("playwright-pro"), "PREFER_NATIVE", "playwright-pro is blocked. Browser QA remains the usable browser workflow.");

  for (const skill of skills) {
    const slug = skill.metadata?.slug || "";
    if (!slug.endsWith("-2")) continue;
    const base = bySlug.get(slug.slice(0, -2));
    if (!base) continue;
    const same = (base.description || "").trim() === (skill.description || "").trim();
    if (same) {
      add(base, skill, "DISABLE_DUPLICATE", "The -2 package repeats the same description and workflow. It stays installed and is not routed.");
    } else {
      add(base, skill, "MERGE_LATER", "The -2 package shares a name stem but the text differs. Leave both installed for manual review.");
    }
  }

  return pairs;
}

export function duplicateDisableIds(pairs: DuplicatePair[]): Set<string> {
  const ids = new Set<string>();
  for (const item of pairs) {
    if (item.decision === "DISABLE_DUPLICATE") ids.add(item.rightId);
  }
  return ids;
}
