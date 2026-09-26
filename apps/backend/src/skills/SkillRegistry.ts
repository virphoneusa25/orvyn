import * as fs from "fs";
import * as path from "path";
import { defaultDataDir } from "../persistence/LocalStore";
import { SkillLoader, type SkillPackage } from "./SkillLoader";
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

/** Installed built-in skills shipped in resources/skills. Enablement is stored beside them, not inside the packages. */
export class SkillRegistry {
  constructor(private readonly loader = new SkillLoader()) {}

  list(): RegistrySkill[] {
    return this.report().skills;
  }

  report(): { skills: RegistrySkill[]; rejected: SkillRejection[] } {
    const loaded = this.loader.load();
    const off = disabledIds();
    return {
      skills: loaded.skills.map((skill) => this.present(skill, !off.has(skill.id))),
      rejected: loaded.rejected,
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
    return { ...skill, enabled, deletable: false };
  }
}

export const skillRegistry = new SkillRegistry();
