// Pure browser Workbench model. No Electron imports so tests run in node.

export type BrowserKind = "browser" | "preview";
export type BrowserOwner = "orion" | "user";

export interface BrowserTab {
  id: string;
  kind: BrowserKind;
  url: string;
  title: string;
  favicon?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  secure: boolean;
  createdAt: number;
  lastActiveAt: number;
  controlOwner: BrowserOwner;
  error?: { code: string; description: string };
  console: string[];
  network: { method: string; url: string; status?: number }[];
  download?: { filename: string; received: number; total: number; state: string };
}

export interface BrowserRecent {
  url: string;
  title: string;
  favicon?: string;
  lastVisitedAt: number;
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DOMAIN = /^(localhost|\[::1\]|(\d{1,3}\.){3}\d{1,3}|([a-z0-9-]+\.)+[a-z]{2,})(:\d{2,5})?(\/.*)?$/i;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i;

export function browserTabId(id: string): string {
  return id.startsWith("browser:") || id.startsWith("preview:") ? id : `browser:${id}`;
}

export function parseBrowserWorkbenchId(id: string): { kind: BrowserKind; sessionId: string } | null {
  if (id.startsWith("browser:")) return { kind: "browser", sessionId: id.slice("browser:".length) };
  if (id.startsWith("preview:")) return { kind: "preview", sessionId: id.slice("preview:".length) };
  if (id === "browser") return { kind: "browser", sessionId: "start" };
  return null;
}

export function isSafeBrowserUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function isLocalBrowserUrl(url: string): boolean {
  try {
    return LOCAL_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function looksLikeUrlOrDomain(raw: string): boolean {
  const t = raw.trim();
  if (!t) return false;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^(localhost|127\.0\.0\.1|\[::1\])/i.test(t)) return true;
  return DOMAIN.test(t) && !/\s/.test(t);
}

export function normalizeBrowserInput(raw: string): { ok: true; url: string } | { ok: false; reason: string; search?: string } {
  const text = raw.trim();
  if (!text) return { ok: false, reason: "empty" };
  if (/^(javascript|data|vbscript|file):/i.test(text)) return { ok: false, reason: "blocked-scheme" };
  if (/^https?:\/\//i.test(text)) {
    return isSafeBrowserUrl(text) ? { ok: true, url: text } : { ok: false, reason: "invalid-url" };
  }
  if (/^(localhost|127\.0\.0\.1|\[::1\])/i.test(text)) {
    const url = text.includes("://") ? text : `http://${text}`;
    return isSafeBrowserUrl(url) ? { ok: true, url } : { ok: false, reason: "invalid-url" };
  }
  if (looksLikeUrlOrDomain(text)) {
    const url = `https://${text}`;
    return isSafeBrowserUrl(url) ? { ok: true, url } : { ok: false, reason: "invalid-url" };
  }
  return { ok: false, reason: "not-a-url", search: text };
}

export function clampBrowserBounds(bounds: BrowserBounds): BrowserBounds | null {
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) {
    return null;
  }
  const width = Math.round(bounds.width);
  const height = Math.round(bounds.height);
  if (width < 80 || height < 80 || width > 8000 || height > 8000) return null;
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width,
    height,
  };
}

export function rememberBrowserRecent(recents: BrowserRecent[], entry: BrowserRecent, limit = 16): BrowserRecent[] {
  if (!isSafeBrowserUrl(entry.url)) return recents;
  const next = [
    { ...entry, lastVisitedAt: entry.lastVisitedAt || Date.now() },
    ...recents.filter((r) => r.url !== entry.url),
  ];
  return next.slice(0, limit);
}

export function publicBrowserTab(tab: BrowserTab): Omit<BrowserTab, "console" | "network"> & { console: string[]; network: BrowserTab["network"] } {
  return {
    id: tab.id,
    kind: tab.kind,
    url: tab.url,
    title: tab.title,
    favicon: tab.favicon,
    loading: tab.loading,
    canGoBack: tab.canGoBack,
    canGoForward: tab.canGoForward,
    secure: tab.secure,
    createdAt: tab.createdAt,
    lastActiveAt: tab.lastActiveAt,
    controlOwner: tab.controlOwner,
    error: tab.error,
    console: tab.console.slice(-20),
    network: tab.network.slice(-20),
    download: tab.download,
  };
}

export function requestBrowserControl(tab: BrowserTab, next: BrowserOwner): { ok: boolean; reason?: string } {
  tab.controlOwner = next;
  return { ok: true };
}

export function truncateTabTitle(title: string, max = 28): string {
  const t = title.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export function previewWorkbenchTitle(url: string, projectName?: string | null): string {
  try {
    const u = new URL(url);
    const port = u.port ? `:${u.port}` : "";
    return `${(projectName || "ORVYN").slice(0, 18)} ${port}`.trim();
  } catch {
    return "Preview";
  }
}

export function guestSecurityPrefs() {
  return {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    preload: undefined as undefined,
  };
}
