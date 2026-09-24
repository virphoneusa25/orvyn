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

const WEBSITE = /\b(website|web\s*site|landing\s*page|one[- ]page)\b/i;

export function introductionFor(instruction: string): string | null {
  if (!WEBSITE.test(instruction)) return null;
  return "I'll build this as a working page in the ORVYN workspace, launch the preview, and inspect the rendered site before I call it finished.";
}

/** One progress line when evidence crosses a real boundary. Null if nothing new is worth saying. */
export function progressFor(before: RunEvidence, after: RunEvidence): string | null {
  if (!before.previewUrl && after.previewUrl) {
    return `The page is written. The live preview is ${after.previewUrl}. I'm checking the rendered site.`;
  }
  if (before.files.length === 0 && after.files.length > 0 && !after.previewUrl) {
    const names = after.files.slice(0, 4).map((p) => p.split("/").pop()).join(", ");
    return `I have the first files in place (${names}). Next I'll get the preview up so I can look at the page itself.`;
  }
  if (!before.verified && after.verified && after.previewUrl) {
    return "Finished. The site is running and the Browser check passed. The preview is still up.";
  }
  return null;
}
