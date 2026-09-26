import * as fs from "fs";
import * as path from "path";
import { defaultDataDir } from "../persistence/LocalStore";
import type { RankableSkill } from "./SkillRanker";

export type SkillEventType = "skills.routed" | "skill.enabled" | "skill.disabled";

export interface SkillEventRecord {
  at: string;
  type: SkillEventType;
  detail: string;
  skillId?: string;
  payload?: Record<string, unknown>;
}

export interface LoggedRank {
  id: string;
  name: string;
  score: number;
  tier: string;
  selected: boolean;
  source: "builtin" | "imported";
  tags: string[];
  category: string;
}

export interface SkillRouteSnapshot {
  at: string;
  instruction: string;
  candidateCount: number;
  selectedCount: number;
  rejectedByCapabilityCount: number;
  rejectedByScoreCount: number;
  reasonSummary: string;
  selected: LoggedRank[];
  additional: LoggedRank[];
  rejectedByCapability: Array<{ id: string; name: string; reason: string }>;
  rejectedByScore: Array<{ id: string; name: string; reason: string }>;
  overlapsCollapsed: Array<{ keptId: string; keptName: string; droppedId: string; droppedName: string }>;
}

interface RouteLogInput {
  candidateCount: number;
  reasonSummary: string;
  selected: Array<{ id: string; name: string }>;
  rejectedByCapability: Array<{ id: string; name: string; reason: string }>;
  rejectedByScore: Array<{ id: string; name: string; reason: string }>;
  ranked: Array<{ id: string; name: string; score: number; tier: string; selected: boolean }>;
  overlapsCollapsed: Array<{ keptId: string; keptName: string; droppedId: string; droppedName: string }>;
}

function latestFile(): string {
  return path.join(defaultDataDir(), "skill-route-latest.json");
}

function eventsFile(): string {
  return path.join(defaultDataDir(), "skill-events.jsonl");
}

function decorate(row: RouteLogInput["ranked"][number], skills: readonly RankableSkill[]): LoggedRank {
  const skill = skills.find((item) => item.id === row.id);
  const imported = skill ? skill.builtin === false || skill.metadata?.source === "imported" : false;
  return {
    id: row.id,
    name: row.name,
    score: row.score,
    tier: row.tier,
    selected: row.selected,
    source: imported ? "imported" : "builtin",
    tags: skill?.metadata?.tags ?? [],
    category: skill?.metadata?.category || skill?.category || "",
  };
}

/** Persist the production route. Called only for live registry routing, after selection is finished. */
export function recordSkillRoute(instruction: string, skills: readonly RankableSkill[], result: RouteLogInput): void {
  const ranked = result.ranked.map((row) => decorate(row, skills));
  const snapshot: SkillRouteSnapshot = {
    at: new Date().toISOString(),
    instruction: instruction.slice(0, 2000),
    candidateCount: result.candidateCount,
    selectedCount: result.selected.length,
    rejectedByCapabilityCount: result.rejectedByCapability.length,
    rejectedByScoreCount: result.rejectedByScore.length,
    reasonSummary: result.reasonSummary,
    selected: ranked.filter((row) => row.selected),
    additional: ranked.filter((row) => !row.selected),
    rejectedByCapability: result.rejectedByCapability,
    rejectedByScore: result.rejectedByScore,
    overlapsCollapsed: result.overlapsCollapsed,
  };
  const dir = defaultDataDir();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${latestFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
  fs.renameSync(tmp, latestFile());
  recordSkillEvent({
    type: "skills.routed",
    detail: result.reasonSummary,
    payload: {
      candidateCount: result.candidateCount,
      selectedCount: result.selected.length,
      rejectedByCapability: result.rejectedByCapability.length,
      rejectedByScore: result.rejectedByScore.length,
      selectedSkillIds: result.selected.map((skill) => skill.id),
      selectedSkillNames: result.selected.map((skill) => skill.name),
    },
  });
}

export function latestSkillRoute(): SkillRouteSnapshot | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(latestFile(), "utf8")) as SkillRouteSnapshot;
    if (!parsed || typeof parsed.candidateCount !== "number" || !Array.isArray(parsed.selected)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function recordSkillEvent(event: Omit<SkillEventRecord, "at"> & { at?: string }): void {
  const row: SkillEventRecord = {
    at: event.at ?? new Date().toISOString(),
    type: event.type,
    detail: event.detail,
    skillId: event.skillId,
    payload: event.payload,
  };
  const dir = defaultDataDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(eventsFile(), `${JSON.stringify(row)}\n`);
  try {
    if (fs.statSync(eventsFile()).size > 256_000) {
      const lines = fs.readFileSync(eventsFile(), "utf8").trim().split(/\n/).slice(-100);
      fs.writeFileSync(eventsFile(), `${lines.join("\n")}\n`);
    }
  } catch {
    // The appended line is still the event of record.
  }
}

export function listSkillEvents(limit = 40): SkillEventRecord[] {
  try {
    const lines = fs.readFileSync(eventsFile(), "utf8").trim().split(/\n/).filter(Boolean);
    const events: SkillEventRecord[] = [];
    for (const line of lines.slice(-200)) {
      try {
        const parsed = JSON.parse(line) as SkillEventRecord;
        if (parsed.type === "skills.routed" || parsed.type === "skill.enabled" || parsed.type === "skill.disabled") events.push(parsed);
      } catch {
        // Skip a torn line.
      }
    }
    return events.slice(-Math.max(1, limit)).reverse();
  } catch {
    return [];
  }
}
