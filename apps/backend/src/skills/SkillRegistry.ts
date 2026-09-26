import { SkillLoader, type SkillPackage } from "./SkillLoader";

/** Installed built-in skills shipped in resources/skills. */
export class SkillRegistry {
  constructor(private readonly loader = new SkillLoader()) {}

  list(): SkillPackage[] {
    return this.loader.loadBuiltin();
  }
}

export const skillRegistry = new SkillRegistry();
