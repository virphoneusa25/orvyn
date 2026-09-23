import { createHash } from "crypto";
import type { LocalStore } from "../persistence/LocalStore";
import type { Experience } from "./ExperienceStore";
import { sanitizeRecord } from "./sanitize";

export interface SkillCandidate {
  id: string;
  name: string;
  trigger: string;
  description: string;
  requiredTools: string[];
  steps: string[];
  validation: string;
  scope: "tenant";
  confidence: number;
  sourceRuns: string[];
  validated: boolean;
  createdAt: number;
}

export function skillCandidatesFromExperiences(experiences: Experience[]): SkillCandidate[] {
  const groups = new Map<string, Experience[]>();
  for (const exp of experiences) {
    if (exp.result !== "success" || exp.evaluation.eligibleForTraining === false) continue;
    const key = [...exp.toolsUsed].sort().slice(0, 6).join("+") || exp.taskType;
    const list = groups.get(key) ?? [];
    list.push(exp);
    groups.set(key, list);
  }
  const out: SkillCandidate[] = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    const tools = [...new Set(list.flatMap((e) => e.toolsUsed))];
    out.push(sanitizeRecord({
      id: `skill_${createHash("sha256").update(key).digest("hex").slice(0, 12)}`,
      name: key.replace(/\+/g, " → ").slice(0, 80) || "Repeated workflow",
      trigger: `${list.length} successful runs used ${tools.slice(0, 4).join(", ")}`,
      description: "Candidate skill from repeated successful runs. Not promoted until validated.",
      requiredTools: tools,
      steps: tools.map((t) => `Use ${t}`),
      validation: "human review required — do not auto-promote",
      scope: "tenant",
      confidence: Math.min(0.9, 0.4 + list.length * 0.1),
      sourceRuns: list.map((e) => e.runId),
      validated: false,
      createdAt: Date.now(),
    }));
  }
  return out;
}

export function persistSkillCandidates(store: LocalStore, experiences: Experience[]): SkillCandidate[] {
  const skills = skillCandidatesFromExperiences(experiences);
  const existing = store.listLearningRecords("skill", 200);
  for (const s of skills) {
    const hit = existing.find((r) => r.id === s.id);
    if (hit && (hit.payload as { validated?: boolean }).validated) continue;
    store.saveLearningRecord({ id: s.id, kind: "skill", payload: s });
  }
  return skills;
}
