import * as fs from "fs";
import * as path from "path";
import { defaultDataDir } from "../persistence/LocalStore";
import { importedSkillsRoot, SkillLoader, type SkillPackage } from "./SkillLoader";
import { recordSkillEvent } from "./SkillRouteLog";
import type { SkillRejection } from "./types";
import { qualityIndex } from "./quality/SkillQualityReport";

export class SkillControlError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

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
  private snapshot: { key: string; report: { skills: RegistrySkill[]; rejected: SkillRejection[] } } | null = null;

  constructor(
    private readonly loader = new SkillLoader(),
    private readonly imported = importedLoader(),
  ) {}

  list(): RegistrySkill[] {
    return this.report().skills;
  }

  report(): { skills: RegistrySkill[]; rejected: SkillRejection[] } {
    const key = this.prefsKey();
    if (this.snapshot?.key === key) return this.snapshot.report;
    const report = this.loadReport();
    this.snapshot = { key, report };
    return report;
  }

  private prefsKey(): string {
    const file = prefsFile();
    try {
      return `${file}:${fs.statSync(file).mtimeMs}`;
    } catch {
      return `${file}:0`;
    }
  }

  private loadReport(): { skills: RegistrySkill[]; rejected: SkillRejection[] } {
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
    const current = this.report().skills.find((item) => item.id === id);
    if (!current) throw new SkillControlError("Unknown skill.", 404);
    const blocked = current.metadata.certificationStatus === "blocked" || (current.metadata.source === "imported" && current.metadata.trusted === false);
    if (enabled && blocked) {
      throw new SkillControlError("Blocked skills cannot be enabled until certification changes.", 409);
    }
    const quality = qualityIndex().get(id);
    if (enabled && quality?.qualityStatus === "disabled") {
      throw new SkillControlError("This skill is disabled by the quality review and cannot be enabled until that review changes.", 409);
    }
    const off = disabledIds();
    if (enabled) off.delete(id);
    else off.add(id);
    saveDisabled(off);
    this.snapshot = null;
    const next = this.present(current, enabled);
    if (next.enabled !== current.enabled) {
      recordSkillEvent({
        type: enabled ? "skill.enabled" : "skill.disabled",
        skillId: id,
        detail: `${current.name} ${enabled ? "enabled" : "disabled"}`,
      });
    }
    return next;
  }

  private present(skill: SkillPackage, enabled: boolean): RegistrySkill {
    const blocked = skill.metadata.certificationStatus === "blocked" || skill.metadata.source === "imported" && skill.metadata.trusted === false;
    return { ...skill, enabled: blocked ? false : enabled, deletable: false };
  }
}

export const skillRegistry = new SkillRegistry();
