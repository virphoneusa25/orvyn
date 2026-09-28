// apps/backend/src/agent/previewCheck.ts
//
// Is the live preview really the styled site? An HTTP 200 for the page is not
// enough. The check loads the page the way a browser would:
//   1. index.html → 200, text/html
//   2. every local stylesheet, script, image and font it links (and the
//      url()s inside its stylesheets) → 200 with the right MIME type
//   3. at least one stylesheet with real rules (or an inline <style>)
//   4. when a real browser is available: no failed requests, no page errors,
//      and computed styles that are not the browser defaults.
// A failure names the exact file, status and type, so the agent (and the
// user) sees what is broken instead of a green check.

import { playwrightAvailable } from "../ai/tools/browserTools";

export interface AssetCheck { url: string; path: string; kind: "stylesheet" | "script" | "image" | "font" | "other"; status: number; contentType: string; ok: boolean; required: boolean; issue?: string }
export interface PreviewCheckResult {
  url: string;
  passed: boolean;
  pageStatus: number;
  assets: AssetCheck[];
  stylesheetsLoaded: number;
  styled: boolean;
  browser?: { ran: boolean; bodyBackground?: string; bodyFont?: string; failedRequests: string[]; pageErrors: string[]; defaultStyles?: boolean; error?: string };
  issues: string[];
}

const KIND: [RegExp, AssetCheck["kind"], RegExp][] = [
  [/\.css$/i, "stylesheet", /^text\/css/i],
  [/\.m?js$/i, "script", /javascript|ecmascript/i],
  [/\.(png|jpe?g|gif|webp|avif|ico|svg)$/i, "image", /^image\//i],
  [/\.(woff2?|ttf|otf)$/i, "font", /^(font\/|application\/(font|x-font|octet-stream))/i],
];

function kindOf(path: string): { kind: AssetCheck["kind"]; mime: RegExp | null } {
  for (const [re, kind, mime] of KIND) if (re.test(path)) return { kind, mime };
  return { kind: "other", mime: null };
}

/** Local asset URLs the page references (resolved against the page URL, same origin only). */
export function linkedAssetUrls(pageUrl: string, html: string): { url: string; path: string; required: boolean }[] {
  const base = new URL(pageUrl);
  const out = new Map<string, { url: string; path: string; required: boolean }>();
  const add = (ref: string, required: boolean) => {
    const clean = ref.trim();
    if (!clean || /^(data|blob|mailto|tel|javascript):/i.test(clean) || clean.startsWith("#")) return;
    let u: URL;
    try { u = new URL(clean, base); } catch { return; }
    if (u.origin !== base.origin) return;
    const path = u.pathname;
    if (!/\.(css|m?js|png|jpe?g|gif|webp|avif|ico|svg|woff2?|ttf|otf)$/i.test(path)) return;
    const key = u.origin + u.pathname;
    const prev = out.get(key);
    out.set(key, { url: key, path, required: required || Boolean(prev?.required) });
  };
  const body = html.replace(/<!--[\s\S]*?-->/g, " ");
  for (const m of body.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const href = /\shref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const rel = /\srel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1] ?? "";
    if (href && /stylesheet/i.test(rel)) add(href, true);
    else if (href && /icon|preload|modulepreload/i.test(rel)) add(href, false);
  }
  for (const m of body.matchAll(/<script\b[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi)) add(m[1]!, true);
  for (const m of body.matchAll(/<(?:img|source|video|image)\b[^>]*\s(?:src|poster|href)\s*=\s*["']([^"']+)["']/gi)) add(m[1]!, true);
  for (const m of body.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi)) add(m[1]!, true);
  return [...out.values()];
}

/** A stylesheet that actually styles something (not empty, not only comments). */
function hasRules(css: string): boolean {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return /[^{}]+\{[^{}]*:[^{}]*\}/.test(text);
}

export async function checkPreview(pageUrl: string, opts: { browser?: boolean; timeoutMs?: number } = {}): Promise<PreviewCheckResult> {
  const issues: string[] = [];
  const timeout = opts.timeoutMs ?? 15_000;
  const get = async (url: string) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
      const buf = Buffer.from(await r.arrayBuffer());
      return { status: r.status, contentType: r.headers.get("content-type") ?? "", body: buf };
    } catch {
      return { status: 0, contentType: "", body: Buffer.alloc(0) };
    } finally { clearTimeout(t); }
  };

  const page = await get(pageUrl);
  if (page.status !== 200) issues.push(`index.html → ${page.status || "no response"}`);
  else if (!/text\/html/i.test(page.contentType)) issues.push(`index.html is served as ${page.contentType || "no type"}, not text/html`);
  const html = page.body.toString("utf8");
  const assets: AssetCheck[] = [];
  let stylesheetsLoaded = 0;
  let styled = /<style\b[^>]*>([\s\S]*?)<\/style>/i.test(html) && hasRules([...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n"));
  const queue = linkedAssetUrls(pageUrl, html);
  const seen = new Set<string>();
  while (queue.length && assets.length < 60) {
    const ref = queue.shift()!;
    if (seen.has(ref.url)) continue;
    seen.add(ref.url);
    const r = await get(ref.url);
    const { kind, mime } = kindOf(ref.path);
    const typeOk = !mime || mime.test(r.contentType);
    const ok = r.status === 200 && typeOk && r.body.length > 0;
    const name = decodeURIComponent(ref.path.split("/").slice(-3).join("/").replace(/^.*?sites\/[^/]+\//, ""));
    const issue = r.status !== 200 ? `${name} → ${r.status || "no response"}` : !typeOk ? `${name} is served as ${r.contentType || "no type"}` : r.body.length === 0 ? `${name} is empty` : undefined;
    assets.push({ url: ref.url, path: ref.path, kind, status: r.status, contentType: r.contentType, ok, required: ref.required, ...(issue ? { issue } : {}) });
    if (!ok && ref.required) issues.push(issue!);
    if (ok && kind === "stylesheet") {
      const css = r.body.toString("utf8");
      stylesheetsLoaded++;
      if (hasRules(css)) styled = true;
      // Images and fonts the stylesheet needs (hero backgrounds live here).
      for (const inner of linkedAssetUrls(ref.url, css.replace(/^/, "<style>") + "</style>")) if (!seen.has(inner.url)) queue.push(inner);
    }
  }
  const linksStylesheet = assets.some((a) => a.kind === "stylesheet");
  if (page.status === 200 && !styled) issues.push(linksStylesheet ? "No stylesheet loaded, so the page renders unstyled." : "The page has no stylesheet or <style> — it renders as bare HTML.");

  let browser: PreviewCheckResult["browser"];
  if (opts.browser !== false && page.status === 200 && playwrightAvailable()) {
    browser = await browserCheck(pageUrl, timeout);
    if (browser.ran) {
      for (const f of browser.failedRequests.slice(0, 5)) if (!issues.some((i) => f.includes(i.split(" ")[0]!))) issues.push(`Browser: ${f}`);
      for (const e of browser.pageErrors.slice(0, 3)) issues.push(`Page error: ${e}`);
      if (browser.defaultStyles) issues.push("In the browser the page shows default styles (white background, default font).");
    }
  }
  return { url: pageUrl, passed: issues.length === 0, pageStatus: page.status, assets, stylesheetsLoaded, styled, ...(browser ? { browser } : {}), issues };
}

/** The page in a real headless browser: failed requests, page errors, computed body styles. */
async function browserCheck(url: string, timeout: number): Promise<NonNullable<PreviewCheckResult["browser"]>> {
  const failedRequests: string[] = [];
  const pageErrors: string[] = [];
  let b: any;
  try {
    const pw: any = await import("playwright");
    b = await pw.chromium.launch({ headless: true }).catch(() => pw.chromium.launch({ headless: true, channel: "chrome" }));
    const page = await b.newPage();
    const origin = new URL(url).origin;
    page.on("requestfailed", (r: any) => { if (r.url().startsWith(origin)) failedRequests.push(`${r.url().split("/").pop()} failed (${r.failure()?.errorText ?? "error"})`); });
    page.on("response", (r: any) => { if (r.url().startsWith(origin) && r.status() >= 400) failedRequests.push(`${decodeURIComponent(r.url().split("/").pop() ?? "")} → ${r.status()}`); });
    page.on("pageerror", (e: any) => pageErrors.push(String(e?.message ?? e).slice(0, 200)));
    await page.goto(url, { waitUntil: "load", timeout });
    const styles = await page.evaluate(() => {
      const cs = getComputedStyle(document.body);
      const html = getComputedStyle(document.documentElement);
      const bg = cs.backgroundColor === "rgba(0, 0, 0, 0)" ? html.backgroundColor : cs.backgroundColor;
      const img = cs.backgroundImage !== "none" || html.backgroundImage !== "none";
      const sheets = Array.from(document.styleSheets).reduce((n, s) => { try { return n + (s.cssRules?.length ?? 0); } catch { return n + 1; } }, 0);
      return { bg, font: cs.fontFamily, img, sheets };
    });
    const whiteBg = !styles.img && (styles.bg === "rgb(255, 255, 255)" || styles.bg === "rgba(0, 0, 0, 0)");
    const defaultFont = /^("?Times New Roman"?|serif|Times)\b/i.test(styles.font);
    return { ran: true, bodyBackground: styles.bg, bodyFont: styles.font, failedRequests, pageErrors, defaultStyles: styles.sheets === 0 || (whiteBg && defaultFont) };
  } catch (err: any) {
    return { ran: false, failedRequests, pageErrors, error: String(err?.message ?? err).slice(0, 200) };
  } finally {
    await b?.close().catch(() => undefined);
  }
}
