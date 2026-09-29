import { useEffect, useState } from "react";

// A small history router: the portal's pages are real URLs (/chats/…, /billing).

type Listener = () => void;
const listeners = new Set<Listener>();

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (to === location.pathname + location.search) return;
  if (opts.replace) history.replaceState(null, "", to); else history.pushState(null, "", to);
  listeners.forEach((l) => l());
  window.scrollTo(0, 0);
}

export function useLocation(): { path: string; query: URLSearchParams } {
  const [, force] = useState(0);
  useEffect(() => {
    const on = () => force((n) => n + 1);
    listeners.add(on);
    window.addEventListener("popstate", on);
    return () => { listeners.delete(on); window.removeEventListener("popstate", on); };
  }, []);
  return { path: location.pathname, query: new URLSearchParams(location.search) };
}

/** "/chats/:id" → { id } when it matches. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/").filter(Boolean);
  const b = path.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.startsWith(":")) out[a[i]!.slice(1)] = decodeURIComponent(b[i]!);
    else if (a[i] !== b[i]) return null;
  }
  return out;
}
