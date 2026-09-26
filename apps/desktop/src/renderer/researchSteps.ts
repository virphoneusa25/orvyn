// The web research behind an answer, as steps for the research timeline
// ("Searched the web, read 5 pages"), from chat activity or run tool rows.

import { domainOf, type RunSource } from "./runSources.ts";

export interface ResearchStep {
  id: string;
  kind: "search" | "read";
  status: "running" | "done" | "failed";
  /** Search: the query. Read: the URL. */
  label: string;
  url?: string;
  domain?: string;
  results?: number;
}

export interface ActivityLike {
  id: string;
  kind: "search" | "read";
  status: "running" | "done" | "failed";
  query?: string;
  url?: string;
  title?: string;
  results?: number;
  found?: { url: string; title: string; snippet?: string }[];
}

export function stepsFromActivity(activity: ActivityLike[] | undefined): ResearchStep[] {
  return (activity ?? []).map((a) => a.kind === "search"
    ? { id: a.id, kind: "search", status: a.status, label: a.query ?? "", results: a.results }
    : { id: a.id, kind: "read", status: a.status, label: a.url ?? "", url: a.url, domain: a.url ? domainOf(a.url) : undefined });
}

/** "Searched the web, read 5 pages" */
export function researchSummary(steps: ResearchStep[], live: boolean): string {
  const searches = steps.filter((s) => s.kind === "search").length;
  const reads = steps.filter((s) => s.kind === "read" && s.status !== "failed").length;
  if (live && !steps.some((s) => s.status !== "running")) return "Searching the web…";
  const parts: string[] = [];
  if (searches) parts.push(searches > 1 ? `Searched the web ${searches} times` : "Searched the web");
  if (reads) parts.push(`read ${reads} ${reads === 1 ? "page" : "pages"}`);
  const text = parts.join(", ") || "Researched";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The answer's Sources from chat activity: pages read first, then search results. */
export function sourcesFromActivity(activity: ActivityLike[] | undefined): RunSource[] {
  const byUrl = new Map<string, RunSource>();
  const key = (u: string) => u.replace(/#.*$/, "").replace(/\/$/, "");
  // A page's title and snippet from the search that found it, when the page itself had none.
  const seen = new Map<string, { title: string; snippet?: string }>();
  for (const a of activity ?? []) for (const f of a.kind === "search" ? a.found ?? [] : []) if (!seen.has(key(f.url))) seen.set(key(f.url), f);
  for (const a of activity ?? []) {
    if (a.kind === "read" && a.status === "done" && a.url) {
      const hit = seen.get(key(a.url));
      byUrl.set(key(a.url), { url: a.url, domain: domainOf(a.url), title: a.title || hit?.title || domainOf(a.url), kind: "read", snippet: hit?.snippet });
    }
  }
  for (const a of activity ?? []) {
    if (a.kind !== "search") continue;
    for (const f of a.found ?? []) {
      if (!byUrl.has(key(f.url))) byUrl.set(key(f.url), { url: f.url, domain: domainOf(f.url), title: f.title || domainOf(f.url), kind: "search", snippet: f.snippet, query: a.query });
    }
  }
  return [...byUrl.values()];
}
