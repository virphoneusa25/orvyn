import * as fs from "fs";
import * as path from "path";

export interface SkillPackage {
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
  validated: true;
  builtin: true;
  installed: true;
  category: string;
  version: string;
  source: string;
  dir: string;
  instructions: string;
}

/** Walk upward until resources/skills exists. Works from the repo root and from apps/backend. */
export function builtinSkillsRoot(start = process.cwd()): string {
  const override = process.env.ORVYN_SKILLS_DIR?.trim();
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`ORVYN_SKILLS_DIR does not exist: ${override}`);
    return override;
  }
  const origins = [start, __dirname];
  for (const origin of origins) {
    let dir = origin;
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, "resources", "skills");
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error("Built-in skills directory resources/skills was not found.");
}

function stepsFromMarkdown(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*\d+\.\s+(.+)$/)?.[1]?.trim() ?? "")
    .filter(Boolean);
}

function readPackage(dir: string): SkillPackage {
  const metaPath = path.join(dir, "skill.json");
  const bodyPath = path.join(dir, "SKILL.md");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Partial<SkillPackage> & { category?: unknown; version?: unknown };
  const instructions = fs.readFileSync(bodyPath, "utf8");
  const steps = stepsFromMarkdown(instructions);
  if (!meta.id || !meta.name) throw new Error(`Skill package ${dir} is missing id or name.`);
  if (steps.length === 0) throw new Error(`Skill package ${dir} has no numbered steps in SKILL.md.`);
  return {
    id: meta.id,
    name: meta.name,
    trigger: String(meta.trigger ?? ""),
    description: String(meta.description ?? ""),
    requiredTools: Array.isArray(meta.requiredTools) ? meta.requiredTools.map(String) : [],
    steps,
    validation: String(meta.validation ?? ""),
    scope: "tenant",
    confidence: typeof meta.confidence === "number" ? meta.confidence : 1,
    sourceRuns: Array.isArray(meta.sourceRuns) ? meta.sourceRuns.map(String) : ["seed"],
    validated: true,
    builtin: true,
    installed: true,
    category: typeof meta.category === "string" && meta.category.trim() ? meta.category.trim() : "General",
    version: typeof meta.version === "string" && meta.version.trim() ? meta.version.trim() : "1.0.0",
    source: "built-in",
    dir,
    instructions,
  };
}

export class SkillLoader {
  constructor(private readonly root = builtinSkillsRoot()) {}

  /** Load every packaged built-in that has both skill.json and SKILL.md. */
  loadBuiltin(): SkillPackage[] {
    const names = fs.readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const skills: SkillPackage[] = [];
    for (const name of names) {
      const dir = path.join(this.root, name);
      if (!fs.existsSync(path.join(dir, "skill.json")) || !fs.existsSync(path.join(dir, "SKILL.md"))) continue;
      skills.push(readPackage(dir));
    }
    return skills;
  }
}
