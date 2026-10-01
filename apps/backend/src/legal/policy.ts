// apps/backend/src/legal/policy.ts
export const LEGAL_VERSION = "2026-10-01";

export const REQUIRED_LEGAL_DOCUMENTS = [
  "eula",
  "privacy",
  "acceptable_use",
  "ai_agent_disclosure",
] as const;

export type LegalDocumentType = (typeof REQUIRED_LEGAL_DOCUMENTS)[number];
