import type { LocalStore } from "../persistence/LocalStore";
import type { SkillCandidate } from "./skillCandidates";

/** First production Skills. These are playbooks, not learned candidates. */
export const VALIDATED_SKILLS: SkillCandidate[] = [
  {
    id: "skill_deliver_file",
    name: "Deliver a generated file",
    trigger: "logo, PNG, image, PDF, document, zip, generate a file",
    description:
      "Create a real file in ORVYN virtual storage and hand it to the user from Files → Generated.",
    requiredTools: ["generate_image", "create_document", "artifact_create"],
    steps: [
      "Call generate_image, create_document, or artifact_create. Do not write a sandbox path.",
      "Succeed only when the tool result includes artifactId and the persisted filename.",
      "Tell the user the file is in Files → Generated (virtual file storage). The chat card is Preview / Download / Show in Files.",
      "Never invent a filename or a sandbox/artifacts/.../download path.",
    ],
    validation: "artifact.created with status ready + readable bytes",
    scope: "tenant",
    confidence: 1,
    sourceRuns: ["seed"],
    validated: true,
    createdAt: 0,
  },
  {
    id: "skill_code_with_tests",
    name: "Ship code with proof",
    trigger: "fix, test, refactor, typecheck, lint, failing tests",
    description: "Edit the project, then prove the change with tests before claiming done.",
    requiredTools: ["read_file", "edit_file", "run_tests", "run_typecheck"],
    steps: [
      "Inspect with search_codebase / read_file before editing.",
      "Make the smallest change that fixes the request.",
      "Run tests or typecheck. If they fail, diagnose and retry.",
      "Do not finish while tests are red or unrun when the user asked to verify.",
    ],
    validation: "run_tests or test.completed passed",
    scope: "tenant",
    confidence: 1,
    sourceRuns: ["seed"],
    validated: true,
    createdAt: 0,
  },
  {
    id: "skill_visual_verify",
    name: "Verify the UI you changed",
    trigger: "dashboard, layout, CSS, visible bug, screenshot, preview",
    description: "Change the UI, then capture proof the user can see.",
    requiredTools: ["browser_screenshot", "desktop_screenshot", "browser_open"],
    steps: [
      "Open or start the preview the user cares about.",
      "Take a browser or desktop screenshot after the change.",
      "Fix what the screenshot shows. Do not claim the layout is fixed from code alone.",
    ],
    validation: "desktop.verification.passed or screenshot artifact",
    scope: "tenant",
    confidence: 1,
    sourceRuns: ["seed"],
    validated: true,
    createdAt: 0,
  },
];

export function seedValidatedSkills(store: LocalStore): SkillCandidate[] {
  const now = Date.now();
  for (const skill of VALIDATED_SKILLS) {
    const existing = store.listLearningRecords("skill", 200).find((r) => r.id === skill.id);
    const payload = existing?.payload as SkillCandidate | undefined;
    if (payload?.validated && payload.name === skill.name) continue;
    store.saveLearningRecord({
      id: skill.id,
      kind: "skill",
      payload: { ...skill, createdAt: payload?.createdAt || now },
    });
  }
  return listValidatedSkills(store);
}

export function listValidatedSkills(store?: LocalStore): SkillCandidate[] {
  if (!store) return VALIDATED_SKILLS.map((s) => ({ ...s }));
  const rows = store.listLearningRecords("skill", 200)
    .map((r) => r.payload as SkillCandidate)
    .filter((s) => s?.validated && s.id);
  const byId = new Map(rows.map((s) => [s.id, s]));
  for (const seed of VALIDATED_SKILLS) {
    if (!byId.has(seed.id)) byId.set(seed.id, seed);
  }
  return [...byId.values()];
}

export function matchValidatedSkills(instruction: string, store?: LocalStore): SkillCandidate[] {
  const text = String(instruction ?? "").toLowerCase();
  return listValidatedSkills(store).filter((skill) => {
    const needles = skill.trigger.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    return needles.some((n) => text.includes(n));
  });
}

export function skillsPromptFor(instruction: string, store?: LocalStore): string {
  const matched = matchValidatedSkills(instruction, store);
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
