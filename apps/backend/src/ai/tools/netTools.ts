// apps/backend/src/ai/tools/netTools.ts
//
// Network tools for the research/coding agents. Both are NETWORK-capability
// tools, so read-only modes deny them and Agent mode gates them on approval.

import { AITool, ToolResult } from "../ToolTypes";

const MAX_BODY = 60_000;
const FETCH_TIMEOUT_MS = 20_000;

/** Refuses obviously private/loopback targets so agents can't probe the LAN. */
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^127\.|^0\.|^10\.|^192\.168\.|^169\.254\./.test(h)) return true;
  const m = /^172\.(\d+)\./.exec(h);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return h === "::1" || h === "[::1]";
}

/** Very small HTML→text pass so models get readable content, not tag soup. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function makeFetchUrlTool(): AITool {
  return {
    name: "fetch_url",
    description:
      "Fetch an http(s) URL and return its text content (HTML is stripped to readable text). For docs, APIs, changelogs. Cannot reach localhost or private networks.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL" },
      },
      required: ["url"],
    },
    defaultPermission: "ask",
    async execute(args): Promise<ToolResult> {
      let parsed: URL;
      try {
        parsed = new URL(String(args.url ?? ""));
      } catch {
        return { ok: false, error: "Invalid URL" };
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, error: "Only http/https URLs are allowed" };
      }
      if (isBlockedHost(parsed.hostname)) {
        return { ok: false, error: "Refusing to fetch localhost/private network addresses" };
      }
      try {
        const res = await fetch(parsed.toString(), {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { "User-Agent": "ORVYN-Agent/1.0", Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
          redirect: "follow",
        });
        const type = res.headers.get("content-type") ?? "";
        const body = await res.text();
        const text = /text\/html/.test(type) ? htmlToText(body) : body;
        const clipped = text.length > MAX_BODY ? text.slice(0, MAX_BODY) + "\n…(truncated)" : text;
        return { ok: true, output: `HTTP ${res.status} ${type}\n\n${clipped}` };
      } catch (err: any) {
        return { ok: false, error: `Fetch failed: ${err.message}` };
      }
    },
  };
}

export function makeWebSearchTool(): AITool {
  return {
    name: "web_search",
    description:
      "Search the web and return the top results (title, URL, snippet). Uses the Brave Search API when BRAVE_SEARCH_API_KEY is set, otherwise DuckDuckGo.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Max results (default 6)" },
      },
      required: ["query"],
    },
    defaultPermission: "ask",
    async execute(args): Promise<ToolResult> {
      const query = String(args.query ?? "").trim();
      if (!query) return { ok: false, error: "Empty query" };
      const limit = Math.min(Math.max(Number(args.limit) || 6, 1), 10);

      const braveKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
      try {
        if (braveKey) {
          const res = await fetch(
            `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
            {
              headers: { "X-Subscription-Token": braveKey, Accept: "application/json" },
              signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            }
          );
          if (!res.ok) return { ok: false, error: `Brave search HTTP ${res.status}` };
          const data: any = await res.json();
          const rows = (data.web?.results ?? []).slice(0, limit);
          if (rows.length === 0) return { ok: true, output: "(no results)" };
          return {
            ok: true,
            output: rows
              .map((r: any, i: number) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${htmlToText(String(r.description ?? ""))}`)
              .join("\n"),
          };
        }

        // Keyless fallback: DuckDuckGo's HTML endpoint.
        const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
          headers: { "User-Agent": "ORVYN-Agent/1.0" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) return { ok: false, error: `DuckDuckGo HTTP ${res.status}` };
        const html = await res.text();
        const results: { title: string; url: string; snippet: string }[] = [];
        const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\//g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(html)) && results.length < limit) {
          let url = m[1];
          const uddg = /uddg=([^&]+)/.exec(url);
          if (uddg) url = decodeURIComponent(uddg[1]);
          results.push({ title: htmlToText(m[2]), url, snippet: htmlToText(m[3]) });
        }
        if (results.length === 0) return { ok: true, output: "(no results parsed — try fetch_url on a specific page)" };
        return {
          ok: true,
          output: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n"),
        };
      } catch (err: any) {
        return { ok: false, error: `Search failed: ${err.message}` };
      }
    },
  };
}
