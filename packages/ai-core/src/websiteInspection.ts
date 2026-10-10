/** Reviewing a live site is observation, not frontend implementation. */
export function isWebsiteInspection(instruction: string): boolean {
  const text = String(instruction ?? "").trim();
  if (/\b(ssh|codebase|repository|repo|source code|pull requests?)\b/i.test(text)) return false;
  if (/^how\s+(do|can|should|would|to)\b/i.test(text)) return false;
  const site = /https?:\/\/\S+|\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|ai|co|edu|gov|us|uk|de|xyz)\b|\b(website|web site|webpage|homepage|web app|landing page)\b/i.test(text);
  if (!site) return false;
  const inspection = /\b(review|audit|inspect|evaluate|analy[sz]e|examine|look at|take a look|check|view|veiw|read|visit|browse|open)\b|\bwhat (?:do you think|can you see|does .{0,45}look like)\b/i.test(text);
  if (!inspection) return false;
  // Suggested changes are a review deliverable; explicit editing remains work.
  const actions = text.replace(/\b(?:suggest|recommend|propose|list improvements|tell me how|how (?:to|we (?:can|could)))\b[^.!?\n]*/gi, "");
  return !/\b(create|build|edit|update|fix|modify|redesign|implement|replace|change|add|remove|deploy|improve)\b/i.test(actions);
}

