// apps/backend/src/ai/tools/netTools.ts
//
// Network tools for the research/coding agents. Both are NETWORK-capability
// tools, so read-only modes deny them and Agent mode gates them on approval.
//
// fetch_url is a control-plane HTTP client (not OpenShell). Sites that 403 a
// bot User-Agent are retried through Playwright Chromium — the same engine
// browser_open uses. OpenShell still deny-by-default; it never uses host *.

import { AITool, ToolResult } from "../ToolTypes";

const MAX_BODY = 60_000;
const FETCH_TIMEOUT_MS = 20_000;

export const BROWSER_USER_AGENT =
  process.env.ORVYN_FETCH_USER_AGENT?.trim() ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export function browserFetchHeaders(): Record<string, string> {
  return {
    "User-Agent": BROWSER_USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
  };
}

/** Refuses obviously private/loopback targets so agents can't probe the LAN. */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^127\.|^0\.|^10\.|^192\.168\.|^169\.254\./.test(h)) return true;
  const m = /^172\.(\d+)\./.exec(h);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return h === "::1" || h === "[::1]";
}

/** Very small HTML→text pass so models get readable content, not tag soup. */
export function htmlToText(html: string): string {
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

export function looksLikeWafBlock(status: number, body: string, contentType = ""): boolean {
  if (status === 401 || status === 403 || status === 429 || status === 503) return true;
  const sample = `${contentType}\n${body.slice(0, 4000)}`;
  return /cf-browser-validation|just a moment|attention required|enable javascript and cookies|cloudflare|access denied|akamai|blocked by|captcha|challenge-platform/i.test(sample);
}

function clipBody(text: string): string {
  return text.length > MAX_BODY ? text.slice(0, MAX_BODY) + "\n…(truncated)" : text;
}

async function fetchWithPlaywright(url: string): Promise<{ status: number; type: string; text: string } | null> {
  let pw: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    pw = require("playwright");
  } catch {
    return null;
  }
  let browser: any;
  try {
    const attempts: { channel?: string }[] = [{}, { channel: "chrome" }, { channel: "msedge" }];
    let lastErr: any;
    for (const opts of attempts) {
      try {
        browser = await pw.chromium.launch({ headless: true, ...opts });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!browser) throw lastErr ?? new Error("chromium launch failed");
    const page = await browser.newPage({
      userAgent: BROWSER_USER_AGENT,
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
        "Upgrade-Insecure-Requests": "1",
      },
      viewport: { width: 1280, height: 800 },
    });
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: FETCH_TIMEOUT_MS });
    await page.waitForTimeout(800).catch(() => undefined);
    const status = response?.status() ?? 0;
    const type = response?.headers()?.["content-type"] ?? "text/html";
    const html = await page.content();
    const text = await page.evaluate(() => (document.body?.innerText || "").slice(0, 80_000)).catch(() => htmlToText(html));
    return { status, type, text: String(text || htmlToText(html)) };
  } catch {
    return null;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

export function makeFetchUrlTool(): AITool {
  return {
    name: "fetch_url",
    description:
      "Fetch an http(s) URL and return its text content (HTML is stripped to readable text). Uses a desktop Chrome identity; if a WAF returns 403, retries in Playwright Chromium. Cannot reach localhost or private networks. For JS-heavy pages, browser_open is still the live preview.",
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
      const target = parsed.toString();
      try {
        const res = await fetch(target, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: browserFetchHeaders(),
          redirect: "follow",
        });
        const type = res.headers.get("content-type") ?? "";
        const body = await res.text();
        const blocked = looksLikeWafBlock(res.status, body, type);
        if (!blocked) {
          const text = /text\/html/.test(type) ? htmlToText(body) : body;
          const clipped = clipBody(text);
          if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, output: `HTTP ${res.status} ${type}\n\n${clipped}` };
          return { ok: true, output: `HTTP ${res.status} ${type}\n\n${clipped}` };
        }
        const viaBrowser = await fetchWithPlaywright(target);
        if (viaBrowser && !looksLikeWafBlock(viaBrowser.status, viaBrowser.text, viaBrowser.type)) {
          return {
            ok: viaBrowser.status >= 200 && viaBrowser.status < 400,
            output: `HTTP ${viaBrowser.status} ${viaBrowser.type} (Playwright)\n\n${clipBody(viaBrowser.text)}`,
          };
        }
        return {
          ok: false,
          error: `HTTP ${viaBrowser?.status || res.status} Forbidden. The host is blocking automated HTTP. Use browser_open on this URL so Chromium loads the page the way a person would. OpenShell will not allow a wildcard egress rule; if this run is in a sandbox, request_network_access with access=research and hosts=["${parsed.hostname}"].`,
        };
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
              headers: { "X-Subscription-Token": braveKey, Accept: "application/json", "User-Agent": BROWSER_USER_AGENT },
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

        const searchBase = process.env.ORVYN_WEB_SEARCH_URL?.trim() || "https://html.duckduckgo.com/html/";
        const res = await fetch(`${searchBase}?q=${encodeURIComponent(query)}`, {
          headers: browserFetchHeaders(),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) return { ok: false, error: `DuckDuckGo HTTP ${res.status}` };
        const html = await res.text();
        if (looksLikeWafBlock(res.status, html)) {
          return { ok: false, error: `DuckDuckGo HTTP ${res.status} (blocked). Set BRAVE_SEARCH_API_KEY or fetch_url a known page.` };
        }
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
