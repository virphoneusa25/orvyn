// apps/backend/src/ai/chatResearch.ts
//
// Chat that researches on its own, like the best chat assistants: the model
// is offered web_search and fetch_url and decides for itself when a question
// needs current facts. Each search and page read is reported as live
// activity ("Searched the web, read 5 pages"), and the pages it read become
// the answer's Sources.

import type { ToolDefinition } from "@orvyn/ai-core";
import { parseSearchResults } from "../gateway/toolResultEnvelope";

export interface ChatActivity {
  id: string;
  kind: "search" | "read";
  status: "running" | "done" | "failed";
  query?: string;
  url?: string;
  title?: string;
  /** Search: how many results came back. */
  results?: number;
  /** Search: the result sites (for Sources). */
  found?: { url: string; title: string; snippet?: string }[];
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface WebToolRunner {
  execute(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; output?: string; error?: string }>;
}

export const CHAT_WEB_TOOLS: ToolDefinition[] = [
  {
    name: "web_search",
    description: "Search the web. Returns the top results (title, URL, snippet). Use it whenever the answer depends on facts you may not have or that change.",
    parameters: { type: "object", properties: { query: { type: "string", description: "What to search for" } }, required: ["query"] },
  },
  {
    name: "fetch_url",
    description: "Read a web page (http/https). Use it on the most relevant search results before answering from them.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
];

export const CHAT_RESEARCH_PROMPT = [
  "You can search the web (web_search) and read pages (fetch_url) in this chat. Decide for yourself when to use them:",
  "- Research whenever the answer depends on facts you may not have or that change: prices and costs, plans and limits, versions and releases, companies, products and people, laws and policies, news, or anything you are not sure is still current. Questions about what something costs, whether it is worth it, or how it compares usually need this.",
  "- Search with specific queries, read the 2-5 most relevant pages with fetch_url, then answer from what they say. Several searches are fine when the question has several parts.",
  "- Do not search for small talk, arithmetic, writing help, or things you know reliably.",
  "- After researching, answer the question itself (with your recommendation), use the numbers you found, and end with a short Sources list of the pages you used.",
].join("\n");

/** Activity for a tool call about to run. */
export function startActivity(id: string, name: string, args: Record<string, unknown>): ChatActivity {
  return name === "web_search"
    ? { id, kind: "search", status: "running", query: String(args.query ?? ""), startedAt: Date.now() }
    : { id, kind: "read", status: "running", url: String(args.url ?? ""), startedAt: Date.now() };
}

/** The same activity once its result is in. */
export function finishActivity(a: ChatActivity, result: { ok: boolean; output?: string; error?: string }): ChatActivity {
  const out = String(result.output ?? "");
  if (!result.ok) return { ...a, status: "failed", error: String(result.error ?? "failed").slice(0, 200), endedAt: Date.now() };
  if (a.kind === "search") {
    const found = parseSearchResults(out).map((r) => ({ url: r.url, title: r.title, snippet: r.snippet.slice(0, 240) }));
    return { ...a, status: "done", results: found.length, found, endedAt: Date.now() };
  }
  const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(out)?.[1]?.trim();
  return { ...a, status: "done", title, endedAt: Date.now() };
}

/** What the model gets back from a tool (clipped: pages can be long). */
export function toolResultForModel(result: { ok: boolean; output?: string; error?: string }): string {
  const text = result.ok ? String(result.output ?? "") : `Error: ${String(result.error ?? "failed")}`;
  return text.length > 24_000 ? `${text.slice(0, 24_000)}\n…(page truncated)` : text;
}
