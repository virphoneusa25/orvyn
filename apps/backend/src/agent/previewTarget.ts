// apps/backend/src/agent/previewTarget.ts
//
// THE one authoritative preview target for a run.
//
// Every consumer of "the page this mission produced" must ask
// getActivePreviewTarget(runId) and use that absolute URL:
//   Preview pane events (preview.available), the Browser tool,
//   computer-use desktop navigation, screenshot/console/network checks.
// Nothing may reconstruct a target from a filename ("index.html"), the cwd,
// or a relative path. Navigation guards below make that impossible to miss.

/** A bare filename, relative path, or scheme-less host fragment is not a URL. */
export type InvalidPreviewTargetReason =
  | "EMPTY"
  | "NOT_ABSOLUTE"
  | "BAD_SCHEME"
  | "LOCALHOST_NOT_ALLOWED"
  | "FILE_NOT_ALLOWED";

export interface NavigationUrlIssue {
  code: "INVALID_PREVIEW_URL";
  target: string;
  reason: InvalidPreviewTargetReason;
  detail: string;
}

export type NavigationUrlCheck = { ok: true; url: string } | { ok: false; issue: NavigationUrlIssue };

/**
 * Validate a navigation target for browser / computer-use verification.
 * Cloud preview verification requires an absolute http(s) URL. file:// is
 * legal only for tools that explicitly serve local files (allowFile).
 * localhost is legal only when the caller explicitly allows it (a local
 * engine serving the preview itself) — a sandbox desktop or cloud worker
 * must never be handed a loopback address of some other machine.
 */
const FILE_TARGET_EXT = /\.(html?|css|mjs|jsx|tsx|vue|svelte|php|aspx|jsp|json|svg|png|jpe?g|webp|gif|avif|ico|woff2?|mp4|md|txt|xml|csv)$/i;

export function validateNavigationUrl(raw: unknown, opts: { allowFile?: boolean; allowLocalhost?: boolean } = {}): NavigationUrlCheck {
  const target = String(raw ?? "").trim();
  if (!target) {
    return { ok: false, issue: { code: "INVALID_PREVIEW_URL", target, reason: "EMPTY", detail: "No URL was given." } };
  }
  // A bare file name ("index.html", "styles.css") — the classic Firefox
  // "Server Not Found at index.html". Distinct from a bare hostname
  // ("example.com"), which normalizes to https:// below.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) && !target.startsWith("//")) {
    if (FILE_TARGET_EXT.test(target) || target.startsWith("./") || target.startsWith("../") || !/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(target)) {
      return {
        ok: false,
        issue: {
          code: "INVALID_PREVIEW_URL",
          target,
          reason: "NOT_ABSOLUTE",
          detail: `"${target}" is a file name or relative path, not a URL. Use the run's live preview URL (absolute https://…).`,
        },
      };
    }
    return validateNavigationUrl(`https://${target}`, opts);
  }
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return { ok: false, issue: { code: "INVALID_PREVIEW_URL", target, reason: "NOT_ABSOLUTE", detail: `"${target}" is not a parsable absolute URL.` } };
  }
  if (parsed.protocol === "file:") {
    if (opts.allowFile) return { ok: true, url: parsed.href };
    return {
      ok: false,
      issue: { code: "INVALID_PREVIEW_URL", target, reason: "FILE_NOT_ALLOWED", detail: "file:// URLs are not valid verification targets here; use the live preview URL." },
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, issue: { code: "INVALID_PREVIEW_URL", target, reason: "BAD_SCHEME", detail: `Scheme ${parsed.protocol} is not allowed; verification needs http(s).` } };
  }
  if (!opts.allowLocalhost && /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(parsed.hostname)) {
    return {
      ok: false,
      issue: { code: "INVALID_PREVIEW_URL", target, reason: "LOCALHOST_NOT_ALLOWED", detail: `"${parsed.hostname}" is not reachable from the verification browser; use the live preview URL.` },
    };
  }
  return { ok: true, url: parsed.href };
}

/** A target that looks like a site page reference rather than a URL ("index.html"). */
export function looksLikeRelativeTarget(raw: unknown): boolean {
  const target = String(raw ?? "").trim();
  if (!target || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith("//") || target.startsWith("/")) return false;
  return /\.[a-z0-9]{1,8}$/i.test(target) || target.includes("/") || !target.includes(" ");
}

// ── The active preview target registry ───────────────────────────────────────

export interface PreviewTarget {
  siteId: string;
  /** Canonical absolute URL — the same one the Preview pane loads. */
  url: string;
  status: "starting" | "ready" | "failed" | "stopped";
  revision: number;
  rootPath?: string;
  createdAt: number;
  updatedAt: number;
}

const targets = new Map<string, PreviewTarget>();

export function setActivePreviewTarget(runId: string, target: Omit<PreviewTarget, "createdAt" | "updatedAt">): PreviewTarget {
  const existing = targets.get(runId);
  const full: PreviewTarget = { ...target, createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now() };
  targets.set(runId, full);
  return full;
}

export function getActivePreviewTarget(runId: string): PreviewTarget | undefined {
  return targets.get(runId);
}

export function notePreviewTargetStatus(runId: string, status: PreviewTarget["status"]): void {
  const t = targets.get(runId);
  if (t && t.status !== status) {
    t.status = status;
    t.updatedAt = Date.now();
  }
}

export function forgetPreviewTarget(runId: string): void {
  targets.delete(runId);
}

/**
 * Health-check a canonical preview URL before any browser opens it:
 * expect HTTP 200 and an HTML content type. Never proceed to computer-use
 * against a target that fails this check.
 */
export async function healthCheckPreviewUrl(url: string, timeoutMs = 6000): Promise<{ ok: boolean; status?: number; contentType?: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow", headers: { accept: "text/html,*/*" } });
    const contentType = res.headers.get("content-type") ?? "";
    if (res.status !== 200) return { ok: false, status: res.status, contentType, error: `Preview URL responded ${res.status}.` };
    if (contentType && !/text\/html/i.test(contentType)) return { ok: false, status: res.status, contentType, error: `Preview URL is ${contentType}, not HTML.` };
    return { ok: true, status: res.status, contentType };
  } catch (err: any) {
    return { ok: false, error: `Preview URL did not load: ${String(err?.message ?? err).slice(0, 200)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Common browser error-page titles/text: verifying one of these proves nothing. */
export const ERROR_PAGE_PATTERNS =
  /server not found|can't (?:be reached|find|connect)|unable to connect|problem loading page|site can'?t be reached|err_(?:connection_refused|name_not_resolved|dns|address_unreachable|file_not_found|too_many_redirects)|dnserror|404 not found|not found — |^404$|^500$/i;

/** True when a page title looks like a browser error page. */
export function isErrorPageTitle(title: string): boolean {
  return ERROR_PAGE_PATTERNS.test(String(title ?? "").trim());
}

// ── One resolver for every navigation consumer ───────────────────────────────

export type ResolvedNavigationTarget =
  | { ok: true; url: string; redirectedFrom?: string }
  | { ok: false; issue: NavigationUrlIssue; targetUrl?: string; targetReady?: boolean };

/**
 * THE resolver browser tools and computer use both call: validate the raw
 * target; when it is invalid but the run has a live canonical preview, hand
 * back the canonical URL (same session, no rebuild); when there is no usable
 * preview, fail structurally. A file name is never sent to a browser.
 */
export function resolveNavigationTarget(runId: string, raw: unknown, opts: { allowFile?: boolean } = {}): ResolvedNavigationTarget {
  const check = validateNavigationUrl(raw, opts);
  if (check.ok) return check;
  const target = runId ? targets.get(runId) : undefined;
  if (target && /^https?:\/\//i.test(target.url)) {
    return { ok: true, url: target.url, redirectedFrom: String(raw ?? "").trim() };
  }
  return { ok: false, issue: check.issue, targetUrl: target?.url, targetReady: Boolean(target) };
}

/** The structured tool result for a failed navigation resolution. */
export function invalidPreviewUrlResult(resolution: Extract<ResolvedNavigationTarget, { ok: false }>): { ok: false; error: string; meta: Record<string, unknown> } {
  return {
    ok: false,
    error: [
      `INVALID_PREVIEW_URL: "${resolution.issue.target}" is not a navigable URL (${resolution.issue.reason}).`,
      resolution.targetUrl
        ? `The run's preview target is ${resolution.targetUrl} but is not ready.`
        : "No live preview URL has been published for this run yet.",
      "Publish the site first (write index.html), then navigate to the absolute live preview URL it returns.",
    ].join(" "),
    meta: { code: "INVALID_PREVIEW_URL", target: resolution.issue.target, reason: resolution.issue.reason },
  };
}
