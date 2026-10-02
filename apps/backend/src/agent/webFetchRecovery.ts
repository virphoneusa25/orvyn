// Adaptive recovery for web reads. Direct fetch, Playwright, search, and
// browser are different capabilities. A 401 on one host must not spawn four
// more fetch_url calls (or a jina proxy) and must not dump OpenShell text.

import { fetchHostKey, normalizePublicHttpUrl } from "../ai/tools/netTools";

export type WebFetchFailure =
  | "AUTH_REQUIRED"
  | "ACCESS_DENIED"
  | "BOT_BLOCKED"
  | "NETWORK_UNAVAILABLE"
  | "TIMEOUT"
  | "HOST_POLICY_BLOCKED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "TRANSIENT"
  | "INVALID_REQUEST"
  | "UNKNOWN";

const PROXY_HOSTS = /(^|\.)(r\.jina\.ai|jina\.ai|12ft\.io|outline\.com|textise\.net|removedpaywall\.com)$/i;

export function isFetchProxyUrl(raw: unknown): boolean {
  const n = normalizePublicHttpUrl(raw);
  if (!n.ok) return /jina\.ai/i.test(String(raw ?? ""));
  return PROXY_HOSTS.test(n.url.hostname);
}

export function classifyWebFetchFailure(error: string, status?: number): WebFetchFailure {
  const text = String(error ?? "");
  const code = status ?? Number(/HTTP (\d{3})/.exec(text)?.[1] ?? 0);
  if (isFetchProxyUrl(text) || /jina\.ai|fetch proxy|HOST_POLICY|OpenShell|request_network_access|host \*/i.test(text)) {
    return "HOST_POLICY_BLOCKED";
  }
  if (code === 401 || /\b401\b|unauthorized|login required|auth(entication)? required/i.test(text)) return "AUTH_REQUIRED";
  if (code === 404 || /\b404\b|not found/i.test(text)) return "NOT_FOUND";
  if (code === 429 || /rate.?limit/i.test(text)) return "RATE_LIMITED";
  if (code === 403 || /forbidden|waf|cloudflare|captcha|bot|just a moment/i.test(text)) return "BOT_BLOCKED";
  if (/timed? ?out|ETIMEDOUT/i.test(text)) return "TIMEOUT";
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|network|fetch failed|offline/i.test(text)) return "NETWORK_UNAVAILABLE";
  if (/invalid url|only http/i.test(text)) return "INVALID_REQUEST";
  if (/\b(502|503|504)\b/.test(text)) return "TRANSIENT";
  if (/denied|blocked|refus/i.test(text)) return "ACCESS_DENIED";
  return "UNKNOWN";
}

export function userFacingFetchError(host: string, kind: WebFetchFailure): string {
  const site = host || "the page";
  switch (kind) {
    case "AUTH_REQUIRED":
      return `Could not read ${site} — the server required a login (401).`;
    case "BOT_BLOCKED":
    case "ACCESS_DENIED":
      return `Could not read ${site} — the site blocked automated access.`;
    case "HOST_POLICY_BLOCKED":
      return `Could not read ${site} through a fetch proxy.`;
    case "NOT_FOUND":
      return `Could not read ${site} — the page was not found.`;
    case "RATE_LIMITED":
      return `Could not read ${site} — the site rate-limited the request.`;
    case "TIMEOUT":
      return `Could not read ${site} — the request timed out.`;
    case "NETWORK_UNAVAILABLE":
      return `Could not read ${site} — the network path was unavailable.`;
    case "INVALID_REQUEST":
      return `Could not read ${site} — the URL was not valid.`;
    default:
      return `Could not read ${site}.`;
  }
}

export function sanitizeToolErrorForUser(error: string, url?: unknown): string {
  const host = fetchHostKey(url) || "the page";
  return userFacingFetchError(host, classifyWebFetchFailure(error));
}

/** Same-class fetch failures are not retried (401 on / and /pricing are one class). */
export function sameClassFetchRetry(kind: WebFetchFailure): boolean {
  return kind === "TIMEOUT" || kind === "TRANSIENT" || kind === "RATE_LIMITED";
}

export function modelFetchRecovery(host: string, kind: WebFetchFailure, hasBrowser: boolean): string {
  const site = host || "this host";
  const browser = hasBrowser
    ? `If you still need the live page, call browser_open once on the original https URL (not a proxy).`
    : `A live browser is not available in this chat.`;
  return [
    `fetch_url is blocked for ${site} (${kind}). Do not call fetch_url again for that host or any path on it.`,
    "Do not use r.jina.ai, 12ft, or any other fetch proxy.",
    "Do not mention sandbox network-policy internals to the user.",
    kind === "AUTH_REQUIRED" || kind === "BOT_BLOCKED" || kind === "ACCESS_DENIED"
      ? `Direct HTTP cannot read ${site}. Use web_search snippets (and cached/indexed sources) instead.`
      : `Switch capability: web_search for snippets, then answer from what you have.`,
    browser,
    "Give one concise answer: what you learned, what you could not verify, and stop.",
  ].join(" ");
}

export class FetchAttemptMemory {
  private hosts = new Map<string, WebFetchFailure>();

  remember(url: unknown, error: string): WebFetchFailure {
    const host = fetchHostKey(url);
    const kind = classifyWebFetchFailure(error);
    if (host) this.hosts.set(host, kind);
    return kind;
  }

  kindFor(url: unknown): WebFetchFailure | undefined {
    const host = fetchHostKey(url);
    return host ? this.hosts.get(host) : undefined;
  }

  shouldSkip(url: unknown): { skip: boolean; kind?: WebFetchFailure; host: string; reason: string } {
    if (isFetchProxyUrl(url)) {
      return { skip: true, kind: "HOST_POLICY_BLOCKED", host: fetchHostKey(url), reason: "proxy" };
    }
    const host = fetchHostKey(url);
    const kind = host ? this.hosts.get(host) : undefined;
    if (kind && !sameClassFetchRetry(kind)) {
      return { skip: true, kind, host, reason: "host_blocked" };
    }
    return { skip: false, host, reason: "" };
  }
}

export function firstFetchUrlPerHost<T extends { name: string; arguments?: Record<string, unknown> }>(calls: T[]): { execute: T[]; skip: T[] } {
  const seen = new Set<string>();
  const execute: T[] = [];
  const skip: T[] = [];
  for (const call of calls) {
    if (call.name !== "fetch_url") {
      execute.push(call);
      continue;
    }
    const url = call.arguments?.url;
    if (isFetchProxyUrl(url)) {
      skip.push(call);
      continue;
    }
    const host = fetchHostKey(url);
    if (!host) {
      execute.push(call);
      continue;
    }
    if (seen.has(host)) skip.push(call);
    else {
      seen.add(host);
      execute.push(call);
    }
  }
  return { execute, skip };
}
