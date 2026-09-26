import type { SkillPackage } from "./SkillLoader";

export type SkillTier = "specialist" | "workflow" | "verify" | "generic";

export interface RankableSkill extends SkillPackage {
  enabled?: boolean;
}

export interface ProjectSignals {
  languages: Set<string>;
  fileTypes: Set<string>;
  /** Go sources only, with no JavaScript or TypeScript project markers. */
  goOnly: boolean;
}

export interface RankRequest {
  instruction: string;
  runMode?: string;
  executionTarget?: string;
  availableTools?: Set<string> | readonly string[];
  resources?: { ssh?: boolean; browser?: boolean };
  project: ProjectSignals;
  previousSuccessfulSkillIds?: readonly string[];
}

export interface RankedSkill {
  skill: RankableSkill;
  score: number;
  tier: SkillTier;
  group: string;
}

export interface CapabilityRejection {
  id: string;
  name: string;
  reason: string;
}

export interface ScoreRejection {
  id: string;
  name: string;
  reason: string;
}

export interface OverlapCollapse {
  keptId: string;
  keptName: string;
  droppedId: string;
  droppedName: string;
}

export interface RankResult {
  candidateCount: number;
  selected: RankableSkill[];
  rejectedByCapability: CapabilityRejection[];
  rejectedByScore: ScoreRejection[];
  overlapsCollapsed: OverlapCollapse[];
  reasonSummary: string;
  complex: boolean;
  selectionCap: number;
}

const SELECT_MIN = 40;
const NORMAL_CAP = 5;
const COMPLEX_CAP = 7;
const STOP = new Set(["skill", "skills", "guide", "pro", "the", "and", "for", "with"]);

function norm(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function slugOf(skill: RankableSkill): string {
  return (skill.metadata?.slug || "").toLowerCase();
}

function identity(skill: RankableSkill): string {
  const meta = skill.metadata;
  return [skill.id, skill.name, meta?.slug, meta?.category, skill.category, ...(meta?.tags ?? []), ...(meta?.taskDomains ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function requiredTools(skill: RankableSkill): string[] {
  const fromMeta = skill.metadata?.requiredTools;
  if (Array.isArray(fromMeta) && fromMeta.length) return fromMeta;
  return skill.requiredTools ?? [];
}

function triggersOf(skill: RankableSkill): string[] {
  const listed = skill.metadata?.triggers;
  if (Array.isArray(listed) && listed.length) return listed;
  return (skill.trigger || "").split(",").map((part) => part.trim()).filter(Boolean);
}

function toolSet(tools: RankRequest["availableTools"]): Set<string> | null {
  if (!tools) return null;
  return tools instanceof Set ? tools : new Set(tools);
}

function triggerBonus(instruction: string, skill: RankableSkill): number {
  const low = instruction.toLowerCase();
  let best = 0;
  for (const raw of triggersOf(skill)) {
    const trigger = raw.trim().toLowerCase();
    if (trigger.length < 3 || !low.includes(trigger)) continue;
    const bonus = trigger.length >= 12 ? 90 : trigger.length >= 8 ? 55 : 18;
    if (bonus > best) best = bonus;
  }
  return best;
}

function nameBonus(instruction: string, skill: RankableSkill): number {
  const name = norm(skill.name || "");
  if (name.length <= 6) return 0;
  const tokens = name.split(" ").filter(Boolean);
  if (tokens.length < 2 && name.length < 12) return 0;
  return instruction.toLowerCase().includes(name) ? 100 : 0;
}

interface DomainHit {
  points: number;
  tier: SkillTier;
  group: string;
}

function bestHit(hits: DomainHit[]): DomainHit | null {
  if (!hits.length) return null;
  hits.sort((a, b) => b.points - a.points);
  return hits[0];
}

function domainHit(skill: RankableSkill, instruction: string, project: ProjectSignals): DomainHit | null {
  const slug = slugOf(skill);
  const text = instruction.toLowerCase();
  const hits: DomainHit[] = [];
  const typescript = /\btypescript\b|\.tsx?\b/.test(text) || project.languages.has("typescript") || project.fileTypes.has("ts") || project.fileTypes.has("tsx");
  if (typescript) {
    if (slug === "typescript-engineering") hits.push({ points: 100, tier: "specialist", group: "typescript" });
    if (slug === "code-reviewer" || slug === "code-review") hits.push({ points: 70, tier: "specialist", group: "typescript" });
    if (slug === "coding-agent") hits.push({ points: 60, tier: "workflow", group: "typescript" });
    if (slug === "test-and-verify") hits.push({ points: 55, tier: "verify", group: "typescript" });
  }

  const react = /\breact\b/.test(text) || project.languages.has("react");
  const ui = /\b(mobile|overflow|dashboard|viewport|layout)\b/.test(text);
  if (react) {
    if (slug === "react-best-practices") hits.push({ points: 100, tier: "specialist", group: "react" });
    if (ui && slug === "frontend-design") hits.push({ points: 80, tier: "workflow", group: "react" });
    if (ui && slug === "responsive-ui-testing") hits.push({ points: 75, tier: "specialist", group: "react" });
    if (ui && slug === "visual-verification") hits.push({ points: 68, tier: "verify", group: "react" });
    if (ui && slug === "verify-the-ui-you-changed") hits.push({ points: 65, tier: "verify", group: "react" });
  }

  if (/\bterraform\b/.test(text) || project.fileTypes.has("tf")) {
    if (slug.includes("terraform") || /\bterraform\b/.test(skill.name.toLowerCase())) hits.push({ points: 100, tier: "specialist", group: "terraform" });
    if (/\bnetworking\b/.test(text) && slug === "network-diagnostics") hits.push({ points: 70, tier: "specialist", group: "terraform" });
    if (/\bdeployment\b/.test(text) && slug === "deployment-verification") hits.push({ points: 50, tier: "verify", group: "terraform" });
  }

  if (/\bsip\b/.test(text)) {
    if (slug === "sip-troubleshooting") hits.push({ points: 100, tier: "specialist", group: "sip" });
    if (slug === "rtp-media-diagnosis" && /\b(answer|answered|disconnect|disconnects|drop|drops|ring|rings)\b/.test(text)) {
      hits.push({ points: 80, tier: "specialist", group: "sip" });
    }
    const named: Array<[string, RegExp]> = [
      ["freeswitch-engineering", /\bfreeswitch\b/],
      ["kamailio-engineering", /\bkamailio\b/],
      ["asterisk-engineering", /\basterisk\b/],
      ["opensips-engineering", /\bopensips\b/],
      ["yeti-class-4-engineering", /\byeti\b/],
    ];
    for (const [productSlug, pattern] of named) {
      if (slug === productSlug && pattern.test(text)) hits.push({ points: 90, tier: "specialist", group: "sip" });
    }
  }

  if (/\bpricing\b/.test(text)) {
    if (slug === "pricing-strategy") hits.push({ points: 100, tier: "specialist", group: "pricing" });
    if (slug === "pricing-strategist") hits.push({ points: 60, tier: "specialist", group: "pricing" });
  }

  const opensource = /unfamiliar open-source|open-source application|will not start|startup failure/.test(text);
  if (opensource) {
    if (slug === "open-source-application-engineering") hits.push({ points: 100, tier: "specialist", group: "systems" });
    if (slug === "source-code-patch-and-repair") hits.push({ points: 70, tier: "workflow", group: "systems" });
    if (slug === "configuration-troubleshooting") hits.push({ points: 58, tier: "workflow", group: "systems" });
    if (slug === "application-configuration") hits.push({ points: 55, tier: "workflow", group: "systems" });
    if (slug === "linux-server-diagnostics") hits.push({ points: 52, tier: "generic", group: "systems" });
    if (slug === "linux-application-installation") hits.push({ points: 48, tier: "generic", group: "systems" });
  }

  if (/\bssh\b/.test(text) && slug === "ssh-server-operations") {
    hits.push({ points: 80, tier: "specialist", group: "server" });
  }

  if (slug === "browser-qa" && /\b(browser|page)\b/.test(text) && /\b(test|check|qa|click)\b/.test(text)) {
    hits.push({ points: 80, tier: "specialist", group: "browser" });
  }

  return bestHit(hits);
}

function isReactSkill(skill: RankableSkill): boolean {
  const hay = `${slugOf(skill)} ${skill.name} ${(skill.metadata?.tags ?? []).join(" ")} ${(skill.metadata?.taskDomains ?? []).join(" ")}`;
  return /\breact\b/i.test(hay);
}

function needsBrowser(skill: RankableSkill): boolean {
  if (requiredTools(skill).some((tool) => tool.startsWith("browser_"))) return true;
  const slug = slugOf(skill);
  return slug === "browser-qa" || slug === "visual-verification" || slug === "responsive-ui-testing";
}

function isSshSkill(skill: RankableSkill): boolean {
  if (slugOf(skill) === "ssh-server-operations") return true;
  return /\bssh\b/i.test(skill.name) && !/\bdiagnostics\b|\bconfiguration\b|\binstall/i.test(skill.name);
}

function sshExplanation(instruction: string): boolean {
  return /\bhow\b.{0,40}\bssh\b|\bwhat is ssh\b|\bexplain ssh\b/i.test(instruction);
}

function browserExplanation(instruction: string): boolean {
  return /\bhow\b.{0,40}\bbrowsers?\b|\bwhat is a browser\b|\bexplain (the )?browsers?\b/i.test(instruction);
}

function browserExecution(instruction: string): boolean {
  return /\b(test|tests|click|screenshot|verify|overflow|mobile|qa)\b/i.test(instruction);
}

function capabilityReason(skill: RankableSkill, request: RankRequest): string | null {
  const status = skill.metadata?.certificationStatus;
  if (status === "blocked") return "certification blocked";
  if (skill.enabled === false) return "disabled";
  if (skill.metadata?.source === "imported" && skill.metadata.trusted === false) return "disabled";

  const available = toolSet(request.availableTools);
  if (available) {
    const missing = requiredTools(skill).filter((tool) => !available.has(tool));
    if (missing.length) return `required tool unavailable: ${missing[0]}`;
  }

  if (request.resources?.ssh === false && isSshSkill(skill) && !sshExplanation(request.instruction)) {
    return "ssh server resource unavailable";
  }

  if (
    request.resources?.browser === false
    && needsBrowser(skill)
    && browserExecution(request.instruction)
    && !browserExplanation(request.instruction)
  ) {
    return "browser capability unavailable";
  }

  if (request.project.goOnly && !/\breact\b/i.test(request.instruction) && isReactSkill(skill)) {
    return "framework mismatch";
  }

  return null;
}

function businessSuppress(skill: RankableSkill, instruction: string, score: number): number {
  if (score <= 0) return score;
  if (!/\b(pricing|saas pricing|pricing strategy)\b/i.test(instruction)) return score;
  if (/\b(fix|bug|error|implement|refactor|tests?|api|compile|typescript|function|endpoint)\b/i.test(instruction)) return score;
  const hay = identity(skill);
  if (/pricing|commercial|marketing|product/.test(hay)) return score;
  const category = `${skill.category || ""} ${skill.metadata?.category || ""}`.toLowerCase();
  if (/(engineering|server|telecom|browser|systems)/.test(category)) return 0;
  return score;
}

function tokens(name: string): Set<string> {
  return new Set(
    norm(name)
      .split(" ")
      .filter((token) => token.length > 2 && !STOP.has(token)),
  );
}

function stem(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 12);
}

function overlaps(a: RankableSkill, b: RankableSkill): boolean {
  const pair = [slugOf(a), slugOf(b)].sort().join("|");
  if (pair === "code-review|code-reviewer") return false;
  const left = tokens(a.name);
  const right = tokens(b.name);
  if (left.size && right.size) {
    let shared = 0;
    for (const token of left) if (right.has(token)) shared += 1;
    if (shared / Math.min(left.size, right.size) >= 0.67) return true;
  }
  const aStem = stem(a.name);
  const bStem = stem(b.name);
  return aStem.length >= 12 && aStem === bStem;
}

function tierRank(tier: SkillTier): number {
  if (tier === "specialist") return 0;
  if (tier === "workflow") return 1;
  if (tier === "verify") return 2;
  return 3;
}

function builtinRank(skill: RankableSkill): number {
  if (skill.builtin || skill.metadata?.builtIn) return 0;
  const source = skill.metadata?.source || skill.source;
  return source === "builtin" || source === "built-in" ? 0 : 1;
}

function modeBoost(skill: RankableSkill, request: RankRequest, score: number): number {
  if (score <= 0) return score;
  const mode = (request.runMode || "").toLowerCase();
  const category = `${skill.category || ""} ${skill.metadata?.category || ""}`.toLowerCase();
  let extra = 0;
  if (mode === "research" && category.includes("research")) extra += 8;
  if ((mode === "server" || mode === "deploy") && category.includes("server")) extra += 8;
  const target = (request.executionTarget || "").toLowerCase();
  if (/ssh|remote|ovh|server/.test(target) && category.includes("server")) extra += 6;
  return score + extra;
}

function relatedBoost(skill: RankableSkill, score: number, positive: Set<string>): number {
  if (score <= 0) return score;
  const related = skill.metadata?.relatedSkillIds ?? [];
  return related.some((id) => id !== skill.id && positive.has(id)) ? score + 8 : score;
}

function groupLabel(group: string): string {
  switch (group) {
    case "typescript": return "TypeScript";
    case "react": return "React interface";
    case "terraform": return "Terraform";
    case "sip": return "SIP";
    case "pricing": return "pricing";
    case "systems": return "open-source application";
    case "server": return "server";
    case "browser": return "browser";
    default: return "general";
  }
}

export function rankSkills(skills: RankableSkill[], request: RankRequest): RankResult {
  const previous = new Set(request.previousSuccessfulSkillIds ?? []);
  const base = skills.map((skill) => {
    const hit = domainHit(skill, request.instruction, request.project);
    let score = triggerBonus(request.instruction, skill) + nameBonus(request.instruction, skill) + (hit?.points ?? 0);
    score = businessSuppress(skill, request.instruction, score);
    if (score > 0 && previous.has(skill.id)) score += 15;
    return { skill, score, tier: hit?.tier ?? "generic", group: hit?.group ?? "" };
  });

  const positive = new Set(base.filter((item) => item.score > 0).map((item) => item.skill.id));
  for (const item of base) {
    item.score = relatedBoost(item.skill, item.score, positive);
    item.score = modeBoost(item.skill, request, item.score);
  }

  const rejectedByCapability: CapabilityRejection[] = [];
  const eligible: RankedSkill[] = [];
  for (const item of base) {
    const reason = capabilityReason(item.skill, request);
    if (reason) {
      if (item.score > 0) {
        rejectedByCapability.push({ id: item.skill.id, name: item.skill.name, reason });
      }
      continue;
    }
    if (item.score > 0) eligible.push(item);
  }

  const groups = new Set(eligible.filter((item) => item.score >= SELECT_MIN && item.group).map((item) => item.group));
  const ands = request.instruction.match(/\band\b/gi)?.length ?? 0;
  const complex = groups.size >= 3 || request.instruction.length > 280 || ands >= 2;
  const selectionCap = complex ? COMPLEX_CAP : NORMAL_CAP;

  eligible.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const tier = tierRank(a.tier) - tierRank(b.tier);
    if (tier !== 0) return tier;
    const built = builtinRank(a.skill) - builtinRank(b.skill);
    if (built !== 0) return built;
    return a.skill.name.localeCompare(b.skill.name);
  });

  const selected: RankedSkill[] = [];
  const rejectedByScore: ScoreRejection[] = [];
  const overlapsCollapsed: OverlapCollapse[] = [];
  for (const item of eligible) {
    if (item.score < SELECT_MIN) {
      rejectedByScore.push({ id: item.skill.id, name: item.skill.name, reason: "below relevance threshold" });
      continue;
    }
    const kept = selected.find((current) => overlaps(current.skill, item.skill));
    if (kept) {
      overlapsCollapsed.push({
        keptId: kept.skill.id,
        keptName: kept.skill.name,
        droppedId: item.skill.id,
        droppedName: item.skill.name,
      });
      rejectedByScore.push({ id: item.skill.id, name: item.skill.name, reason: `overlaps ${kept.skill.name}` });
      continue;
    }
    if (selected.length >= selectionCap) {
      rejectedByScore.push({ id: item.skill.id, name: item.skill.name, reason: "below selection cap" });
      continue;
    }
    selected.push(item);
  }

  const names = selected.map((item) => item.skill.name);
  const lead = selected.find((item) => item.group)?.group ?? "";
  const reasonSummary = names.length
    ? `Selected ${names.length} skill${names.length === 1 ? "" : "s"} for this ${groupLabel(lead)} task: ${names.join(", ")}.`
    : "No skill matched this request closely enough to load.";

  return {
    candidateCount: eligible.length,
    selected: selected.map((item) => item.skill),
    rejectedByCapability,
    rejectedByScore,
    overlapsCollapsed,
    reasonSummary,
    complex,
    selectionCap,
  };
}
