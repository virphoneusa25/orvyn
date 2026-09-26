// The sites ORION searched and read during a run: the stream's "Sources".
// Built from the tool result envelopes (url evidence from web_search and
// fetch_url, and pages the browser opened). The verifier's own checks and
// ORVYN's previews are not sources.

export interface RunSource {
  url: string;
  domain: string;
  title: string;
  /** read: ORION opened the page; search: it came up in a web search. */
  kind: "read" | "search";
  snippet?: string;
  query?: string;
}

interface EventLike { type: string; data?: Record<string, any> }

const LOCAL = /^https?:\/\/(localhost|127\.|\[::1\]|0\.0\.0\.0)/i;
const PREVIEW = /\/api\/v1\/sites\//;

export function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

export function collectSources(events: EventLike[]): RunSource[] {
  const byUrl = new Map<string, RunSource>();
  const add = (s: RunSource) => {
    if (!/^https?:\/\//i.test(s.url) || LOCAL.test(s.url) || PREVIEW.test(s.url)) return;
    const key = s.url.replace(/#.*$/, "").replace(/\/$/, "");
    const prev = byUrl.get(key);
    // A page ORION read outranks the same page seen in a search result.
    if (!prev || (prev.kind === "search" && s.kind === "read")) byUrl.set(key, { ...s, title: s.title || prev?.title || s.domain, snippet: s.snippet ?? prev?.snippet });
  };
  for (const e of events) {
    if (e.type !== "tool.completed" || e.data?.verifier) continue;
    const env = e.data?.envelope;
    for (const ev of env?.evidence ?? []) {
      if (ev.type === "url" && typeof ev.value === "string") {
        add({ url: ev.value, domain: domainOf(ev.value), title: String(ev.extra?.title || ev.label || ""), kind: ev.extra?.kind === "search" ? "search" : "read", snippet: ev.extra?.snippet || undefined, query: ev.extra?.query || undefined });
      } else if (ev.type === "browser" && typeof ev.extra?.url === "string" && ev.extra.url) {
        add({ url: ev.extra.url, domain: domainOf(ev.extra.url), title: "", kind: "read" });
      }
    }
  }
  const all = [...byUrl.values()].map((s) => ({ ...s, title: s.title || s.domain }));
  return [...all.filter((s) => s.kind === "read"), ...all.filter((s) => s.kind === "search")];
}

/** One icon per site, in order, for the stacked favicons. */
export function sourceDomains(sources: RunSource[], max = 4): string[] {
  return [...new Set(sources.map((s) => s.domain))].slice(0, max);
}
