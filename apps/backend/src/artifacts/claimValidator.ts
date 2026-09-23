export interface GroundedArtifact {
  artifactId: string;
  name: string;
  mimeType?: string;
}

const CLAIM =
  /\b(generated|download(?:able)?|attached|files\s*→\s*generated|you'll find it|card above)\b/i;
const FILENAME = /\b[\w.-]+\.(png|jpe?g|gif|webp|svg|pdf|docx|xlsx|pptx|zip)\b/gi;
const SANDBOX_PATH = /\b(?:sandbox|\/opt\/orvyn|worker-local)\/\S+/i;

/** Logos, images, and office deliverables that must come back with an artifactId.
 *  A workspace write (hello.txt, source edits) is not one of these. */
export function looksLikeFileDeliverableRequest(text: string): boolean {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/\.(png|jpe?g|gif|webp|svg|pdf|docx|xlsx|pptx|zip)\b/i.test(t)) return true;
  return /\b(generate|create|make|draw|export|save)\b/i.test(t) &&
    /\b(logo|image|png|pdf|docx|document|report|zip|spreadsheet|artifact)\b/i.test(t);
}

/** Create/edit a normal workspace file, then optionally read it back. */
export function looksLikeWorkspaceFileTask(text: string): boolean {
  const t = String(text || "").trim();
  if (!t || looksLikeFileDeliverableRequest(t)) return false;
  return /\b(create|write|add|save|edit|update|modify)\b/i.test(t) && /\b(file|files)\b/i.test(t);
}

export function asksToReadFileBack(text: string): boolean {
  return /\b(read(?:\s+it|\s+the\s+file)?\s+back|what it contains|read the file|tell me (?:exactly )?what)\b/i.test(String(text || ""));
}

export function claimsGeneratedFile(text: string): boolean {
  FILENAME.lastIndex = 0;
  return CLAIM.test(text) || FILENAME.test(text);
}

/** Invented filenames that are not in the persisted set. */
export function inventedFilenames(text: string, artifacts: GroundedArtifact[]): string[] {
  const allowed = new Set(artifacts.map((a) => a.name.toLowerCase()));
  const found = String(text || "").match(FILENAME) ?? [];
  return [...new Set(found.map((n) => n.toLowerCase()))].filter((n) => !allowed.has(n));
}

/**
 * If the assistant claims a file exists without a persisted artifactId, rewrite.
 * Cards must never be inferred from this text.
 */
export function filesGeneratedCopy(artifacts: GroundedArtifact[]): string {
  const names = artifacts.filter((a) => a.artifactId && a.name).map((a) => a.name).join(", ");
  if (!names) return "No file was saved. There is nothing in Files → Generated.";
  return `Saved ${names} in Files → Generated (virtual file storage). Preview or download it from the card — that is the real file.`;
}

export function groundAssistantClaims(text: string, artifacts: GroundedArtifact[]): { text: string; blocked: boolean } {
  const list = artifacts.filter((a) => a.artifactId && a.name);
  if (list.length > 0) {
    const invented = inventedFilenames(text, list);
    const leakedPath = SANDBOX_PATH.test(text) || /sandbox\/artifacts/i.test(text);
    const namesOk = invented.length === 0;
    if (namesOk && !leakedPath) return { text, blocked: false };
    return { text: filesGeneratedCopy(list), blocked: true };
  }
  if (!claimsGeneratedFile(text) && !looksLikeFileDeliverableRequest(text) && !SANDBOX_PATH.test(text)) {
    return { text, blocked: false };
  }
  return {
    text: "No file was saved. Generation or persistence failed, so there is nothing to download and nothing in Files → Generated.",
    blocked: true,
  };
}

export interface ClaimEvent {
  type: string;
  data?: Record<string, unknown>;
}

function toolName(event: ClaimEvent): string {
  return String(event.data?.tool ?? event.data?.name ?? "");
}

function testsPassed(events: ClaimEvent[]): boolean {
  return events.some((event) => {
    if (event.type === "test.completed") return event.data?.ok !== false && event.data?.passed !== false;
    if (event.type === "terminal.completed" && /\b(npm test|vitest|jest|pytest)\b/i.test(String(event.data?.command ?? ""))) {
      return event.data?.exitCode === 0 || event.data?.ok === true;
    }
    return event.type === "tool.completed" && /^(run_tests|test)$/i.test(toolName(event)) && event.data?.ok !== false;
  });
}

function visualEvidence(events: ClaimEvent[]): boolean {
  return events.some((event) =>
    event.type === "desktop.verification.passed" ||
    event.type === "browser.verification.passed" ||
    event.type === "browser.completed" ||
    (event.type === "tool.completed" && /screenshot|browser_|desktop_/i.test(toolName(event)))
  );
}

function changeEvidence(events: ClaimEvent[]): boolean {
  return events.some((event) =>
    event.type === "file.edit" ||
    event.type === "file.changed" ||
    (event.type === "tool.completed" && /edit_file|write_file|deploy/i.test(toolName(event)))
  );
}

/**
 * Drop success sentences that this run's events do not support.
 * Artifact filenames are handled by groundAssistantClaims.
 */
export function groundSuccessClaims(text: string, events: ClaimEvent[]): { text: string; blocked: boolean } {
  const sentences = String(text || "").split(/(?<=[.!?])\s+/).filter(Boolean);
  const kept: string[] = [];
  let blocked = false;
  for (const sentence of sentences) {
    const claimsTests = /\b(tests?\s+(passed|pass|are green|succeeded)|all tests pass)\b/i.test(sentence);
    const claimsVisual = /\b(verified (the )?(ui|page|screen|visually)|visual verification|checked (it )?in the browser|desktop verification passed)\b/i.test(sentence);
    const claimsFix = /\b(i fixed|the bug is fixed|i deployed|deployed the app)\b/i.test(sentence);
    if ((claimsTests && !testsPassed(events)) || (claimsVisual && !visualEvidence(events)) || (claimsFix && !changeEvidence(events))) {
      blocked = true;
      continue;
    }
    kept.push(sentence);
  }
  if (!blocked) return { text, blocked: false };
  const remainder = kept.join(" ").trim();
  return {
    text: remainder || "This run has no tool evidence for that success claim, so it is not reported as done.",
    blocked: true,
  };
}

export function availableArtifactsPrompt(artifacts: GroundedArtifact[]): string {
  if (artifacts.length === 0) {
    return "PERSISTED ARTIFACTS: none. You must not say a file was generated, saved, attached, or is in Files → Generated. Do not invent a filename.";
  }
  const rows = artifacts.map((a) => `- artifactId=${a.artifactId} name=${a.name} mime=${a.mimeType ?? ""}`).join("\n");
  return `PERSISTED ARTIFACTS (only these exist; mention only these names):\n${rows}`;
}
