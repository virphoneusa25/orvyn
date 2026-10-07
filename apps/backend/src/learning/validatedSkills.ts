import type { TenantPersistence as LocalStore } from "../persistence/TenantPersistence";
import { skillRegistry } from "../skills/SkillRegistry";
import type { SkillCandidate } from "./skillCandidates";

/** Packaged built-ins from resources/skills. The agent loop still calls skillsPromptFor. */
function packagedSkills(): SkillCandidate[] {
  return skillRegistry.list().filter((skill) => {
    if (skill.metadata.certificationStatus === "blocked") return false;
    if (skill.metadata.source === "imported" && skill.enabled === false) return false;
    return true;
  }).map((skill) => ({
    id: skill.id,
    name: skill.name,
    trigger: skill.trigger,
    description: skill.description,
    requiredTools: skill.requiredTools,
    steps: skill.steps,
    validation: skill.validation,
    scope: "tenant",
    confidence: skill.confidence,
    sourceRuns: skill.sourceRuns,
    validated: true,
    createdAt: 0,
  }));
}

export async function seedValidatedSkills(store: LocalStore): Promise<SkillCandidate[]> {
  const now = Date.now();
  for (const skill of packagedSkills()) {
    const existing = (await store.listLearningRecords("skill", 200)).find((r) => r.id === skill.id);
    const payload = existing?.payload as SkillCandidate | undefined;
    if (payload?.validated && payload.name === skill.name) continue;
    await store.saveLearningRecord({
      id: skill.id,
      kind: "skill",
      payload: { ...skill, createdAt: payload?.createdAt || now },
    });
  }
  return (await listValidatedSkills(store));
}

export async function listValidatedSkills(store?: LocalStore): Promise<SkillCandidate[]> {
  if (!store) return packagedSkills();
  const rows = (await store.listLearningRecords("skill", 200))
    .map((r) => r.payload as SkillCandidate)
    .filter((s) => s?.validated && s.id);
  const byId = new Map(rows.map((s) => [s.id, s]));
  for (const seed of packagedSkills()) {
    if (!byId.has(seed.id)) byId.set(seed.id, seed);
  }
  return [...byId.values()];
}

export async function matchValidatedSkills(instruction: string, store?: LocalStore): Promise<SkillCandidate[]> {
  const text = String(instruction ?? "").toLowerCase();
  return (await listValidatedSkills(store)).filter((skill) => {
    const needles = skill.trigger.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    return needles.some((n) => text.includes(n));
  });
}

export async function skillsPromptFor(instruction: string, store?: LocalStore): Promise<string> {
  const matched = await matchValidatedSkills(instruction, store);
  if (matched.length === 0) return "";
  const blocks = matched.map((s) => {
    const steps = s.steps.map((step, i) => `  ${i + 1}. ${step}`).join("\n");
    return `SKILL ${s.name} (validated):\n${steps}\n  Gate: ${s.validation}`;
  });
  return [
    "Use these validated ORION skills for this request. They are how the job is done — follow the steps and the gate.",
    ...blocks,
  ].join("\n");
}
