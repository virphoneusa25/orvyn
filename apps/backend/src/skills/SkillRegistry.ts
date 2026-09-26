import * as fs from "fs";
import * as path from "path";
import { defaultDataDir } from "../persistence/LocalStore";
import { importedSkillsRoot, SkillLoader, type SkillPackage } from "./SkillLoader";
import type { SkillRejection } from "./types";

export interface RegistrySkill extends SkillPackage {
  enabled: boolean;
  /** Built-in packages stay installed. This phase has no delete action. */
  deletable: false;
}

function prefsFile(): string {
  return path.join(defaultDataDir(), "skill-preferences.json");
}

function disabledIds(): Set<string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(prefsFile(), "utf8")) as { disabled?: unknown };
    const ids = Array.isArray(parsed.disabled) ? parsed.disabled.filter((id): id is string => typeof id === "string") : [];
    return new Set(ids);
  } catch {
    return new Set();
  }
}

function saveDisabled(ids: Set<string>): void {
  const dir = defaultDataDir();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${prefsFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ disabled: [...ids].sort() }, null, 2));
  fs.renameSync(tmp, prefsFile());
}

function importedLoader(): SkillLoader | null {
  const root = importedSkillsRoot();
  return root ? new SkillLoader(root, true) : null;
}

/** Built-in skills plus certified and partially supported imports. Blocked imports stay disabled. */
export class SkillRegistry {
  constructor(
    private readonly loader = new SkillLoader(),
    private readonly imported = importedLoader(),
  ) {}

  list(): RegistrySkill[] {
    return this.report().skills;
  }

  report(): { skills: RegistrySkill[]; rejected: SkillRejection[] } {
    const loaded = this.loader.load();
    const extra = this.imported?.load() ?? { skills: [], rejected: [] };
    const off = disabledIds();
    const seen = new Set(loaded.skills.map((skill) => skill.id));
    const skills = [...loaded.skills];
    const rejected = [...loaded.rejected];
    for (const skill of extra.skills) {
      if (seen.has(skill.id)) {
        rejected.push({ slug: skill.metadata.slug, dir: skill.dir, errors: [`id ${skill.id} duplicates a production skill and was not installed.`] });
        continue;
      }
      seen.add(skill.id);
      skills.push(skill);
    }
    rejected.push(...extra.rejected);
    return {
      skills: skills.map((skill) => this.present(skill, !off.has(skill.id))),
      rejected,
    };
  }

  setEnabled(id: string, enabled: boolean): RegistrySkill {
    const skill = this.loader.load().skills.find((item) => item.id === id);
    if (!skill) throw new Error("Unknown skill.");
    const off = disabledIds();
    if (enabled) off.delete(id);
    else off.add(id);
    saveDisabled(off);
    return this.present(skill, enabled);
  }

  private present(skill: SkillPackage, enabled: boolean): RegistrySkill {
    const blocked = skill.metadata.certificationStatus === "blocked" || skill.metadata.source === "imported" && skill.metadata.trusted === false;
    return { ...skill, enabled: blocked ? false : enabled, deletable: false };
  }
}

export const skillRegistry = new SkillRegistry();
