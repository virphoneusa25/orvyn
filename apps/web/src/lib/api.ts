// The portal talks to the ORVYN API on its own origin. The session token is
// kept in this browser's storage and sent as a bearer header — never in a URL.
// (The chat socket uses a one-minute single-use ticket instead.)

const KEY = "orvyn.session";

const VIEW_KEY = "orvyn.viewas";

/** A staff "view as customer" tab keeps its read-only token in this tab only (never the staff member's own session). */
export function getViewAsToken(): string | null {
  try { return sessionStorage.getItem(VIEW_KEY); } catch { return null; }
}
export function setViewAsToken(token: string | null): void {
  try { token ? sessionStorage.setItem(VIEW_KEY, token) : sessionStorage.removeItem(VIEW_KEY); } catch { /* storage off */ }
}

export function getToken(): string | null {
  const view = getViewAsToken();
  if (view) return view;
  try { return localStorage.getItem(KEY); } catch { return null; }
}
export function setToken(token: string | null): void {
  try { token ? localStorage.setItem(KEY, token) : localStorage.removeItem(KEY); } catch { /* storage off */ }
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string, readonly body?: any) { super(message); }
}

type Listener = () => void;
const unauthorized = new Set<Listener>();
/** Called when the server says the session is gone (the app returns to sign-in). */
export function onUnauthorized(fn: Listener): () => void { unauthorized.add(fn); return () => unauthorized.delete(fn); }

export async function api<T = any>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api/v1${path}`, {
    method: init.method ?? "GET",
    headers: { ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: init.signal,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    if (res.status === 401 && token && !path.startsWith("/auth/login") && !path.startsWith("/auth/register")) unauthorized.forEach((f) => f());
    throw new ApiError(res.status, data.error || `Request failed (${res.status})`, data.code, data);
  }
  return data as T;
}

/** Fetches a file with the session and returns a blob URL (for thumbnails, previews, downloads). */
export async function blobUrl(path: string, timeoutMs = 45_000): Promise<{ url: string; type: string; blob: Blob }> {
  const token = getToken();
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`/api/v1${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: ctl.signal });
    if (!res.ok) throw new ApiError(res.status, `Could not load the file (${res.status})`);
    const blob = await res.blob();
    return { url: URL.createObjectURL(blob), type: blob.type, blob };
  } catch (err: any) {
    if (err?.name === "AbortError") throw new ApiError(0, "The file took too long to load. Try again.");
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}

const imageLinks = new Map<string, { url: string; exp: number }>();

/**
 * A short-lived direct URL for an image (a capability link, like HTML previews):
 * the browser loads and caches it itself — no script-side download, so a big
 * generated image shows as soon as its bytes arrive.
 */
export async function imageLink(artifactId: string, options: { refresh?: boolean } = {}): Promise<string> {
  const hit = imageLinks.get(artifactId);
  if (!options.refresh && hit && hit.exp > Date.now()) return hit.url;
  const r = await api<{ url: string }>(`/artifacts/${encodeURIComponent(artifactId)}/preview-link`, { method: "POST", body: {} });
  imageLinks.set(artifactId, { url: r.url, exp: Date.now() + 4 * 60_000 });
  return r.url;
}

/** Saves a file to the user's computer (no model involved, no credits). */
export async function downloadArtifact(artifactId: string, name: string): Promise<void> {
  const { url } = await blobUrl(`/artifacts/${encodeURIComponent(artifactId)}/download`);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
