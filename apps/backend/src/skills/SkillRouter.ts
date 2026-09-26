import * as fs from "fs";
import * as path from "path";
import type { SkillPackage } from "./SkillLoader";
import { skillRegistry, type RegistrySkill } from "./SkillRegistry";
import { buildSkillPrompt } from "./SkillContextLoader";
import { rankSkills, type ExposedRank, type ProjectSignals, type RankableSkill } from "./SkillRanker";
import { recordSkillRoute } from "./SkillRouteLog";
import { precedenceOverlay } from "./quality/SkillConflictDetector";
import { qualityIndex } from "./quality/SkillQualityReport";

export interface SkillRouteRequest {
  instruction: string;
  runMode?: string;
  executionTarget?: string;
  availableTools?: Set<string> | readonly string[];
  resources?: { ssh?: boolean; browser?: boolean };
  projectLanguages?: readonly string[];
  fileTypes?: readonly string[];
  openProject?: string;
  previousSuccessfulSkillIds?: readonly string[];
  /** Override the registry. Tests pass a fixed list so ranking does not re-read packages. */
  skills?: readonly RankableSkill[];
}

export interface SkillRouteResult {
  candidateCount: number;
  selected: RankableSkill[];
  rejectedByCapability: Array<{ id: string; name: string; reason: string }>;
  rejectedByScore: Array<{ id: string; name: string; reason: string }>;
  overlapsCollapsed: Array<{ keptId: string; keptName: string; droppedId: string; droppedName: string }>;
  reasonSummary: string;
  complex: boolean;
  selectionCap: number;
  ranked: ExposedRank[];
  prompt: string;
}

function exists(file: string): boolean {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

function addFileType(types: Set<string>, value: string): void {
  const cleaned = value.trim().toLowerCase().replace(/^\./, "");
  if (cleaned) types.add(cleaned);
}

/** Shallow project markers only. Does not walk the tree. */
export function projectSignals(request: Pick<SkillRouteRequest, "projectLanguages" | "fileTypes" | "openProject">): ProjectSignals {
  const languages = new Set((request.projectLanguages ?? []).map((language) => language.toLowerCase()));
  const fileTypes = new Set<string>();
  for (const fileType of request.fileTypes ?? []) addFileType(fileTypes, fileType);

  let packageJson = false;
  if (request.openProject) {
    const root = request.openProject;
    if (exists(path.join(root, "go.mod"))) languages.add("go");
    packageJson = exists(path.join(root, "package.json"));
    const tsconfig = exists(path.join(root, "tsconfig.json"));
    if (exists(path.join(root, "Cargo.toml"))) languages.add("rust");
    if (tsconfig) languages.add("typescript");
    if (packageJson) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.typescript || tsconfig) languages.add("typescript");
        if (deps.react) languages.add("react");
      } catch {
        // A broken package.json is not a language signal.
      }
    }
  }

  if (fileTypes.has("go")) languages.add("go");
  if (fileTypes.has("ts") || fileTypes.has("tsx")) languages.add("typescript");
  if (fileTypes.has("tsx") || fileTypes.has("jsx")) languages.add("react");
  if (fileTypes.has("py")) languages.add("python");
  if (fileTypes.has("rs")) languages.add("rust");

  const jsFamily = languages.has("javascript") || languages.has("typescript") || languages.has("react") || packageJson;
  const goOnly = languages.has("go") && !jsFamily;
  return { languages, fileTypes, goOnly };
}

function registrySkills(): RankableSkill[] {
  return skillRegistry.list();
}

function withQuality(skills: readonly RankableSkill[]): RankableSkill[] {
  const index = qualityIndex();
  if (!index.size) return [...skills];
  return skills.map((skill) => {
    if (skill.qualityStatus) return skill;
    const row = index.get(skill.id);
    if (!row) return skill;
    return { ...skill, qualityStatus: row.qualityStatus, qualityScore: row.qualityScore };
  });
}

/** Classify, filter, rank, and load only the selected skill playbooks. Selection caps stay 5 and 7. */
export function routeSkills(request: SkillRouteRequest): SkillRouteResult {
  const skills = withQuality((request.skills ?? registrySkills()) as RankableSkill[]);
  const ranked = rankSkills(skills, {
    instruction: request.instruction,
    runMode: request.runMode,
    executionTarget: request.executionTarget,
    availableTools: request.availableTools,
    resources: request.resources,
    project: projectSignals(request),
    previousSuccessfulSkillIds: request.previousSuccessfulSkillIds,
  });
  const body = buildSkillPrompt(ranked.selected.map((skill) => ({
    id: skill.id,
    name: skill.name,
    instructions: skill.instructions,
    dir: skill.dir,
  })));
  const overlay = precedenceOverlay(ranked.selected);
  const prompt = overlay && body ? `${overlay}\n\n${body}` : body;
  const result: SkillRouteResult = { ...ranked, prompt };
  if (!request.skills) {
    try {
      recordSkillRoute(request.instruction, skills, result);
    } catch {
      // The route log is observational. A disk failure must not change selection.
    }
  }
  return result;
}

export type { RegistrySkill, SkillPackage };
