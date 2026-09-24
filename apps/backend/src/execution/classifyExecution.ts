/** Prompt hints for Auto routing. Run mode stays separate. */

export interface ExecutionHints {
  isRisky: boolean;
  isBackground: boolean;
  requiresRemote: boolean;
  isVisual: boolean;
  isArtifact: boolean;
  isLocalCoding: boolean;
  /** A site to build and preview. Not a local coding task just because it says "build". */
  isSite: boolean;
}

const REMOTE =
  /\b(deploy|production|remote server|ssh|cloud worker|background mission)\b/i;
const RISKY =
  /\b(untrusted|sandbox|isolate|crash|malware|unknown repo|random repo|don't trust|do not trust)\b/i;
const BACKGROUND =
  /\b(background|long[- ]running|overnight|keep running|watch the server)\b/i;
const VISUAL =
  /\b(dashboard|layout|css|ui|visible|screenshot|browser|localhost|preview|overflow)\b/i;
const ARTIFACT =
  /\b(logo|png|jpg|jpeg|gif|webp|svg|pdf|docx|xlsx|zip|generate|draw|image)\b/i;
const LOCAL_CODE =
  /\b(test|tests|typecheck|lint|build|fix|edit|refactor|commit|git|calculator|file|src\/)\b/i;
const FORCE_LOCAL = /\b(do not use cloud|don't use cloud|do not use Cloud|locally|on this machine|no ovh)\b/i;
const FORCE_CLOUD = /\b(force cloud|cloud worker|(?<!\bdo not )(?<!\bdon't )(?<!\bno )\buse cloud)\b/i;
const FORCE_SANDBOX = /\b(in sandbox|use sandbox|isolated container)\b/i;
const SITE = /\b(website|web\s*site|landing\s*page|one[- ]page|saas site)\b/i;

export function classifyExecutionHints(prompt: string, mode?: string): ExecutionHints {
  const t = String(prompt ?? "");
  const m = String(mode ?? "").toLowerCase();
  return {
    isRisky: RISKY.test(t) || FORCE_SANDBOX.test(t),
    isBackground: BACKGROUND.test(t) || m === "automate",
    requiresRemote: (REMOTE.test(t) || FORCE_CLOUD.test(t) || m === "server" || m === "deploy") && !FORCE_LOCAL.test(t),
    isVisual: VISUAL.test(t),
    isArtifact: ARTIFACT.test(t) && !LOCAL_CODE.test(t),
    isLocalCoding: (LOCAL_CODE.test(t) || FORCE_LOCAL.test(t) || m === "code") && !SITE.test(t),
    isSite: SITE.test(t) && !FORCE_LOCAL.test(t),
  };
}
