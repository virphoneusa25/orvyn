export interface BrowserVerificationResult {
  verificationId: string;
  url: string;
  passed: boolean;
  pageLoaded: boolean;
  expectedContentFound: boolean;
  fatalConsoleErrors: string[];
  issues: string[];
}

const LOCALHOST = /localhost|127\.0\.0\.1|\[::1\]/i;

/** A cloud worker address is not a URL the Windows browser may open. */
export function cloudBrowserUrl(executionTarget: string, workerUrl: string, previewUrl: string): string | null {
  if (executionTarget === "cloud_worker" && LOCALHOST.test(workerUrl)) {
    if (!previewUrl || LOCALHOST.test(previewUrl)) return null;
    return previewUrl;
  }
  return previewUrl || workerUrl;
}

/** Page content, not a status code. An empty 200 does not pass. */
export function assessRenderedPage(url: string, status: number, html: string, opts: { localEngine?: boolean } = {}): BrowserVerificationResult {
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  const words = text.replace(/\s+/g, " ").trim();
  const hasStructure = /<(h1|main|header|nav)\b/i.test(html);
  const issues: string[] = [];
  if (status !== 200) issues.push(`Page responded ${status}.`);
  // On the desktop's own engine, localhost is the user's machine.
  if (LOCALHOST.test(url) && !opts.localEngine) issues.push("The browser was given a localhost URL.");
  if (!hasStructure) issues.push("The page has no heading, navigation, or main content.");
  if (words.length < 40) issues.push("The rendered page has almost no visible text.");
  const passed = issues.length === 0;
  return {
    verificationId: `ver_${Math.random().toString(16).slice(2, 10)}`,
    url,
    passed,
    pageLoaded: status === 200 && html.length > 0,
    expectedContentFound: hasStructure && words.length >= 40,
    fatalConsoleErrors: [],
    issues,
  };
}
