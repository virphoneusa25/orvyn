import type { SkillOrigin } from "../types";

export interface ProvenanceInput {
  repository: string;
  path: string;
  license: string;
  author: string;
  version: string;
  importedAt: string;
}

/** Keep the third-party origin. Missing license text stays an empty string; it is not invented. */
export function licenseLabel(frontmatterLicense: string, licenseFiles: string[]): string {
  if (frontmatterLicense.trim()) return frontmatterLicense.trim();
  if (licenseFiles.length > 0) return `file:${licenseFiles[0]}`;
  return "";
}

export function buildSkillProvenance(input: ProvenanceInput): SkillOrigin {
  return {
    repository: input.repository.trim(),
    path: input.path.trim(),
    license: input.license.trim(),
    author: input.author.trim(),
    version: input.version.trim(),
    importedAt: input.importedAt.trim(),
  };
}
