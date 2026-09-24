// Human conversation for one run. Machine events stay events.
// A line is spoken only when evidence changes, and never claims work that evidence does not show.

export interface RunEvidence {
  files: string[];
  previewUrl?: string;
  browserOpened: boolean;
  verified: boolean;
}

export function collectRunEvidence(events: Array<{ type: string; data?: Record<string, unknown> }>): RunEvidence {
  const files: string[] = [];
  let previewUrl: string | undefined;
  let browserOpened = false;
  let verified = false;
  for (const event of events) {
    if (event.type === "file.created" || event.type === "file.edit") {
      const path = String(event.data?.path ?? "");
      if (path && !files.includes(path)) files.push(path);
    }
    if (event.type === "preview.available") {
      const url = String(event.data?.url ?? "");
      if (/^https?:\/\//i.test(url) && !/localhost|127\.0\.0\.1/i.test(url)) previewUrl = url;
    }
    if (event.type === "browser.opened" || event.type === "browser.completed") browserOpened = true;
    if (event.type === "browser.verification_passed" || event.type === "desktop.verification.passed") verified = true;
  }
  return { files, previewUrl, browserOpened, verified };
}

export function introductionFor(instruction: string, informational = false): string | null {
  if (informational || !instruction.trim()) return null;
  return "I'll do this in the active environment and check the result before I call it finished.";
}

export function planSteps(intent: {
  requiresRemoteResource?: boolean;
  requiresFrontend?: boolean;
  requiresArtifact?: boolean;
  requiresTerminal?: boolean;
  requiresBrowser?: boolean;
}): string[] {
  const steps = ["Inspect what the task needs"];
  if (intent.requiresRemoteResource) steps.push("Use the resolved server");
  if (intent.requiresFrontend) steps.push("Write the files and open the preview");
  else if (intent.requiresArtifact) steps.push("Create the file and confirm it was saved");
  else steps.push("Make the change");
  if (intent.requiresTerminal) steps.push("Run the check");
  if (intent.requiresBrowser) steps.push("Inspect the rendered result");
  steps.push("Finish only when the evidence is there");
  return steps;
}

/** One progress line when evidence crosses a real boundary. Null if nothing new is worth saying. */
export function progressFor(before: RunEvidence, after: RunEvidence): string | null {
  if (!before.previewUrl && after.previewUrl) {
    return `The page is written. The live preview is ${after.previewUrl}. I'm checking the rendered site.`;
  }
  if (before.files.length === 0 && after.files.length > 0 && !after.previewUrl) {
    const names = after.files.slice(0, 4).map((p) => p.split("/").pop()).join(", ");
    return `I have the first files in place (${names}). I'll check the result before calling this finished.`;
  }
  if (!before.verified && after.verified && after.previewUrl) {
    return "Finished. The site is running and the Browser check passed. The preview is still up.";
  }
  return null;
}
