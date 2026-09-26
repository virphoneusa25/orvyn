import type { CertificationStatus, SkillMetadata, UnresolvedTool } from "../types";

export interface ToolResolution {
  requiredTools: string[];
  optionalTools: string[];
  unresolvedTools: UnresolvedTool[];
}

/**
 * Keep an external tool name only when it is already an ORVYN tool.
 * Aliases such as Bash or Read are left unresolved.
 */
export function resolveExternalTools(required: string[], optional: string[], known: Set<string>): ToolResolution {
  const requiredTools: string[] = [];
  const optionalTools: string[] = [];
  const unresolvedTools: UnresolvedTool[] = [];
  const seen = new Set<string>();
  const take = (name: string, requirement: "required" | "optional") => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    if (known.has(name)) {
      if (requirement === "required") requiredTools.push(name);
      else optionalTools.push(name);
      return;
    }
    unresolvedTools.push({ name, requirement });
  };
  for (const name of required) take(name, "required");
  for (const name of optional) take(name, "optional");
  return { requiredTools, optionalTools, unresolvedTools };
}

export function certificationBlockers(originLicense: string, repository: string, path: string, unresolved: UnresolvedTool[]): string[] {
  const blockers: string[] = [];
  if (!repository.trim()) blockers.push("origin.repository is missing.");
  if (!path.trim()) blockers.push("origin.path is missing.");
  if (!originLicense.trim()) blockers.push("Third-party license is missing from frontmatter and from a LICENSE file.");
  for (const tool of unresolved) {
    if (tool.requirement !== "required") continue;
    blockers.push(`Required capability "${tool.name}" is not an ORVYN tool and was left unresolved.`);
  }
  return blockers;
}

/**
 * Certification is a separate decision from import.
 * Required unresolved capabilities reject certification. Optional unresolved tools do not.
 */
export function certifyImportedSkill(metadata: SkillMetadata): { certificationStatus: Exclude<CertificationStatus, "pending">; blockers: string[] } {
  const blockers = new Set<string>(metadata.certificationBlockers ?? []);
  if (metadata.source !== "imported") blockers.add("Only an imported skill can be certified by this check.");
  if (metadata.trusted) blockers.add("An imported skill cannot be certified while trusted is true.");
  if (!metadata.origin?.license.trim()) blockers.add("Third-party license is missing from frontmatter and from a LICENSE file.");
  if (!metadata.origin?.repository.trim()) blockers.add("origin.repository is missing.");
  if (!metadata.origin?.path.trim()) blockers.add("origin.path is missing.");
  for (const tool of metadata.unresolvedTools ?? []) {
    if (tool.requirement !== "required") continue;
    blockers.add(`Required capability "${tool.name}" is not an ORVYN tool and was left unresolved.`);
  }
  const list = [...blockers];
  if (list.length > 0) return { certificationStatus: "rejected", blockers: list };
  return { certificationStatus: "certified", blockers: [] };
}
