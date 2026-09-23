// apps/backend/src/ai/tools/browserTools.ts
//
// Browser QA tools backed by Playwright. Playwright is an OPTIONAL dependency:
// when it is not installed every tool returns the same typed error telling the
// user how to enable it, and the Browser QA agent shows as Pending in the
// roster. No tool pretends to work.

import * as path from "path";
import { promises as fs } from "fs";
import { AITool, ToolResult } from "../ToolTypes";
import { callElectronBrowser } from "../../desktop/electronBrowserTarget";

let browserTenantId = "";

export function setBrowserToolTenant(tenantId: string): void {
  browserTenantId = tenantId;
}

async function electron(path: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> {
  if (!browserTenantId) return null;
  return callElectronBrowser(browserTenantId, path, body);
}

export function playwrightAvailable(): boolean {
  try {
    require.resolve("playwright");
    return true;
  } catch {
    return false;
  }
}

export const PLAYWRIGHT_MISSING =
  "Playwright is not installed. Run `npm install -D playwright` and `npx playwright install chromium` in the ORVYN backend, then restart.";

interface BrowserSession {
  browser: any;
  page: any;
  /** Console errors + uncaught page errors collected since browser_open. */
  consoleErrors: string[];
  /** Failed network requests (non-2xx responses + network errors). */
  failedRequests: { url: string; status: number; method: string }[];
  /** Screenshots taken during this session (file paths). */
  screenshots: string[];
  /** Action log for evidence — what happened, when. */
  actions: { action: string; url?: string; timestamp: number; result?: string }[];
}

// One session per project root; closed when browser_open is called again
// or when the owning run completes (closeBrowserSession).
const sessions = new Map<string, BrowserSession>();

export function getBrowserSession(projectRoot: string): BrowserSession | undefined {
  return sessions.get(projectRoot);
}

export async function ensureBrowserSession(projectRoot: string): Promise<BrowserSession> {
  return sessions.get(projectRoot) ?? openSession(projectRoot);
}

export async function captureBrowserFrame(projectRoot: string): Promise<{ jpeg: Buffer; url: string } | null> {
  const s = sessions.get(projectRoot);
  if (!s) return null;
  const jpeg = Buffer.from(await s.page.screenshot({ type: "jpeg", quality: 62 }));
  return { jpeg, url: String(s.page.url()) };
}

/** Closes the browser session for a project — called on run completion. */
export function closeBrowserSession(projectRoot: string): void {
  const s = sessions.get(projectRoot);
  if (s) {
    void s.browser.close().catch(() => {});
    sessions.delete(projectRoot);
  }
}

/** Closes all browser sessions (shutdown). */
export function closeAllBrowserSessions(): void {
  for (const [key, s] of sessions) {
    void s.browser.close().catch(() => {});
    sessions.delete(key);
  }
}

async function getPage(projectRoot: string): Promise<any> {
  const s = sessions.get(projectRoot);
  if (!s) throw new Error("No browser session. Call browser_open first.");
  return s.page;
}

/**
 * Launch order: Playwright's bundled Chromium, then system Chrome, then
 * system Edge. The channel fallbacks make browser QA work on machines where
 * the bundled-browser download is unavailable (offline, blocked CDN) but a
 * real Chrome/Edge is installed.
 */
async function launchBrowser(pw: any): Promise<any> {
  const attempts: { channel?: string }[] = [{}, { channel: "chrome" }, { channel: "msedge" }];
  let lastErr: any;
  for (const opts of attempts) {
    try {
      return await pw.chromium.launch({ headless: true, ...opts });
    } catch (err: any) {
      lastErr = err;
    }
  }
  throw new Error(
    `Could not launch a browser. Install one with \`npx playwright install chromium\` or install Google Chrome/Microsoft Edge. Last error: ${lastErr?.message}`
  );
}

async function openSession(projectRoot: string): Promise<BrowserSession> {
  // Runtime require so the backend compiles and runs without Playwright.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pw = require("playwright");
  const old = sessions.get(projectRoot);
  if (old) {
    try {
      await old.browser.close();
    } catch {
      // already dead
    }
  }
  const browser = await launchBrowser(pw);
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const session: BrowserSession = {
    browser,
    page,
    consoleErrors: [],
    failedRequests: [],
    screenshots: [],
    actions: [],
  };
  page.on("console", (msg: any) => {
    if (msg.type() === "error") session.consoleErrors.push(`[console.error] ${msg.text()}`.slice(0, 500));
  });
  page.on("pageerror", (err: any) => {
    session.consoleErrors.push(`[pageerror] ${String(err?.message ?? err)}`.slice(0, 500));
  });
  // Track failed network requests (non-2xx + network errors) for evidence.
  page.on("response", (res: any) => {
    const status = res.status();
    if (status >= 400) {
      session.failedRequests.push({
        url: res.url().slice(0, 300),
        status,
        method: res.request()?.method() ?? "GET",
      });
    }
  });
  page.on("requestfailed", (req: any) => {
    session.failedRequests.push({
      url: req.url().slice(0, 300),
      status: 0,
      method: req.method(),
    });
  });
  sessions.set(projectRoot, session);
  return session;
}

/** Full evidence snapshot from the active session — for browser_verify. */
export function browserEvidence(projectRoot: string): {
  consoleErrors: string[];
  failedRequests: { url: string; status: number; method: string }[];
  screenshots: string[];
  actions: { action: string; url?: string; timestamp: number; result?: string }[];
} {
  const s = sessions.get(projectRoot);
  if (!s) return { consoleErrors: [], failedRequests: [], screenshots: [], actions: [] };
  return {
    consoleErrors: [...s.consoleErrors],
    failedRequests: [...s.failedRequests],
    screenshots: [...s.screenshots],
    actions: [...s.actions],
  };
}

function guard<T extends Record<string, unknown>>(
  fn: (args: T) => Promise<ToolResult>,
  opts?: { playwright?: boolean }
): (args: Record<string, unknown>) => Promise<ToolResult> {
  return async (args) => {
    try {
      return await fn(args as T);
    } catch (err: any) {
      if (opts?.playwright !== false && !playwrightAvailable() && /No browser session|playwright|chromium/i.test(String(err?.message))) {
        return { ok: false, error: PLAYWRIGHT_MISSING };
      }
      return { ok: false, error: err.message };
    }
  };
}

function needPlaywright(): ToolResult | null {
  if (playwrightAvailable()) return null;
  return { ok: false, error: PLAYWRIGHT_MISSING };
}

const ENTRY_FILES = ["index.html", "index.htm", "index.php", "index.aspx", "index.jsp", "default.html", "default.aspx"];

/**
 * file:// navigation that fails USEFULLY. A wrong guess like
 * `.../index.html` on a PHP site used to die with a bare ERR_FILE_NOT_FOUND
 * the model had no way to recover from. Now the directory is inspected and
 * the error names the real entry point — and states that server-side entries
 * (PHP/ASP) need the site's HTTP URL, because file:// cannot execute them.
 */
async function gotoWithRecovery(page: any, rawUrl: string): Promise<string> {
  try {
    await page.goto(rawUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return page.url();
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (!/ERR_FILE_NOT_FOUND/.test(msg) || !rawUrl.startsWith("file:///")) throw err;
    const winPath = decodeURIComponent(rawUrl.replace(/^file:\/\/\//, "").replace(/\//g, "\\"));
    let entries: string[] = [];
    try {
      entries = await fs.readdir(path.dirname(winPath));
    } catch {
      /* unreadable directory — report the raw navigation error below */
    }
    const parts = [`page.goto failed: ${msg.split("\n")[0]}`];
    const entry = ENTRY_FILES.find((f) => entries.includes(f));
    if (entry && /\.(php|asp|aspx|jsp)$/i.test(entry)) {
      parts.push(
        `This directory's entry point is ${entry} — a server-side file that file:// CANNOT execute.`,
        `Serve the site over HTTP (e.g. http://localhost/<site-path> or its local domain) and navigate to that URL instead.`
      );
    } else if (entry) {
      parts.push(`This directory's entry point is ${entry} — navigate to that file instead.`);
    } else if (entries.length > 0) {
      parts.push(`The directory exists but has no standard entry file (contains: ${entries.slice(0, 8).join(", ")}…).`);
    }
    throw new Error(parts.join(" "));
  }
}

export function makeBrowserOpenTool(projectRoot: string): AITool {
  return {
    name: "browser_open",
    description:
      "Open a URL in the visible ORVYN Workbench browser when available, otherwise a Playwright session. Replaces any prior hidden session for this project.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "URL to open (optional)" } },
    },
    defaultPermission: "ask",
    execute: guard(async (args) => {
      const url = args.url ? String(args.url) : "";
      const visible = await electron("/v1/browser/open", { url });
      if (visible?.ok) {
        const tab = visible.tab as { id?: string; url?: string } | undefined;
        return { ok: true, output: `Workbench browser ${tab?.id ?? ""} opened${tab?.url ? ` at ${tab.url}` : url ? ` at ${url}` : ""}.` };
      }
      const missing = needPlaywright();
      if (missing) return missing;
      const s = await openSession(projectRoot);
      if (url) await gotoWithRecovery(s.page, url);
      s.actions.push({ action: "open", url, timestamp: Date.now() });
      return { ok: true, output: `Browser session started${url ? ` at ${url}` : ""}.` };
    }),
  };
}

export function makeBrowserNavigateTool(projectRoot: string): AITool {
  return {
    name: "browser_navigate",
    description: "Navigate the open browser session to a URL and report the page title.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    defaultPermission: "ask",
    execute: guard(async (args) => {
      const url = String(args.url);
      const visible = await electron("/v1/browser/navigate", { url });
      if (visible && visible.tabs) {
        const tabs = visible.tabs as { url?: string; title?: string }[];
        const tab = tabs[tabs.length - 1];
        return { ok: true, output: `Now at ${tab?.url ?? url} — title: ${tab?.title ?? ""}` };
      }
      const missing = needPlaywright();
      if (missing) return missing;
      const page = await getPage(projectRoot);
      const finalUrl = await gotoWithRecovery(page, url);
      return { ok: true, output: `Now at ${finalUrl} — title: ${await page.title()}` };
    }),
  };
}

export function makeBrowserClickTool(projectRoot: string): AITool {
  return {
    name: "browser_click",
    description: "Click an element in the open browser session by CSS selector or visible text (text=...).",
    parameters: {
      type: "object",
      properties: { selector: { type: "string" } },
      required: ["selector"],
    },
    defaultPermission: "ask",
    execute: guard(async (args) => {
      const selector = String(args.selector);
      const visible = await electron("/v1/browser/click", { selector });
      if (visible?.ok) return { ok: true, output: `Clicked ${selector} in the Workbench browser.` };
      const missing = needPlaywright();
      if (missing) return missing;
      const page = await getPage(projectRoot);
      await page.click(selector, { timeout: 10_000 });
      return { ok: true, output: `Clicked ${selector}. URL now ${page.url()}` };
    }),
  };
}

export function makeBrowserTypeTool(projectRoot: string): AITool {
  return {
    name: "browser_type",
    description: "Type text into an input in the open browser session (CSS selector), then optionally press Enter.",
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string" },
        text: { type: "string" },
        submit: { type: "boolean", description: "Press Enter afterwards" },
      },
      required: ["selector", "text"],
    },
    defaultPermission: "ask",
    execute: guard(async (args) => {
      const selector = String(args.selector);
      const text = String(args.text);
      const visible = await electron("/v1/browser/type", { selector, text });
      if (visible?.ok) return { ok: true, output: `Typed into ${selector} in the Workbench browser.` };
      const missing = needPlaywright();
      if (missing) return missing;
      const page = await getPage(projectRoot);
      await page.fill(selector, text, { timeout: 10_000 });
      if (args.submit === true) await page.press(selector, "Enter");
      return { ok: true, output: `Typed into ${selector}${args.submit ? " and submitted" : ""}.` };
    }),
  };
}

export function makeBrowserConsoleErrorsTool(projectRoot: string): AITool {
  return {
    name: "browser_console_errors",
    description:
      "Report every console error and uncaught page error collected in the open browser session since browser_open. Empty output means no errors were observed.",
    parameters: { type: "object", properties: {} },
    defaultPermission: "allowed",
    execute: guard(async () => {
      const visible = await electron("/v1/browser/state");
      const tabs = (visible?.tabs as { console?: string[] }[] | undefined) ?? [];
      const lines = tabs.flatMap((t) => t.console ?? []);
      if (visible) {
        return { ok: true, output: lines.length === 0 ? "No console or page errors observed." : lines.join("\n") };
      }
      const missing = needPlaywright();
      if (missing) return missing;
      const s = sessions.get(projectRoot);
      if (!s) return { ok: false, error: "No browser session. Call browser_open first." };
      return {
        ok: true,
        output: s.consoleErrors.length === 0 ? "No console or page errors observed." : s.consoleErrors.join("\n"),
      };
    }),
  };
}

export function makeBrowserScreenshotTool(projectRoot: string): AITool {
  return {
    name: "browser_screenshot",
    description:
      "Screenshot the open browser session to .orvyn/screenshots/ and return the file path (usable as vision input).",
    parameters: {
      type: "object",
      properties: { fullPage: { type: "boolean" } },
    },
    defaultPermission: "ask",
    execute: guard(async (args) => {
      const dir = path.join(projectRoot, ".orvyn", "screenshots");
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `shot_${Date.now()}.png`);
      const visible = await electron("/v1/browser/screenshot");
      if (visible?.ok && typeof visible.png === "string") {
        await fs.writeFile(file, Buffer.from(visible.png, "base64"));
        return {
          ok: true,
          output: `Screenshot saved: ${file}`,
          meta: { screenshot: { b64: visible.png, mediaType: "image/png" }, surface: "browser", desktopHealthy: true },
        };
      }
      const missing = needPlaywright();
      if (missing) return missing;
      const page = await getPage(projectRoot);
      await page.screenshot({ path: file, fullPage: args.fullPage === true });
      const s = sessions.get(projectRoot);
      if (s) {
        s.screenshots.push(file);
        s.actions.push({ action: "screenshot", url: page.url(), timestamp: Date.now(), result: file });
      }
      return { ok: true, output: `Screenshot saved: ${file}` };
    }),
  };
}

export function makeBrowserScrollTool(projectRoot: string): AITool {
  return {
    name: "browser_scroll",
    description: "Scroll the visible Workbench browser (or Playwright fallback) by a pixel delta.",
    parameters: {
      type: "object",
      properties: { deltaY: { type: "number", description: "Positive scrolls down" } },
    },
    defaultPermission: "ask",
    execute: guard(async (args) => {
      const deltaY = Number(args.deltaY ?? 400);
      const visible = await electron("/v1/browser/scroll", { deltaY });
      if (visible?.ok) return { ok: true, output: `Scrolled the Workbench browser by ${deltaY}px.` };
      const missing = needPlaywright();
      if (missing) return missing;
      const page = await getPage(projectRoot);
      await page.mouse.wheel(0, deltaY);
      return { ok: true, output: `Scrolled by ${deltaY}px.` };
    }),
  };
}

export function makeBrowserEvidenceTool(projectRoot: string): AITool {
  return {
    name: "browser_evidence",
    description:
      "Get the full browser session evidence: actions taken, console errors, failed network requests, screenshots, and current URL. Use for verification reports.",
    parameters: { type: "object", properties: {} },
    defaultPermission: "allowed",
    execute: guard(async () => {
      const visible = await electron("/v1/browser/state");
      if (visible?.tabs) {
        const tabs = visible.tabs as { url?: string; title?: string; console?: string[]; network?: { method: string; url: string; status?: number }[] }[];
        const tab = tabs.find((t) => t.url) ?? tabs[0];
        return {
          ok: true,
          output: [
            `URL: ${tab?.url ?? "(none)"}`,
            `Title: ${tab?.title ?? ""}`,
            `Console errors (${tab?.console?.length ?? 0}): ${(tab?.console ?? []).slice(0, 5).join(" | ") || "(none)"}`,
            `Failed requests (${tab?.network?.length ?? 0}): ${(tab?.network ?? []).slice(0, 5).map((n) => `${n.method} ${n.url} [${n.status ?? ""}]`).join(" | ") || "(none)"}`,
            "Source: ORVYN Workbench WebContentsView",
          ].join("\n"),
        };
      }
      const missing = needPlaywright();
      if (missing) return missing;
      const evidence = browserEvidence(projectRoot);
      const s = sessions.get(projectRoot);
      const currentUrl = s ? String(s.page.url()) : "(no session)";
      const lines = [
        `URL: ${currentUrl}`,
        `Actions (${evidence.actions.length}): ${evidence.actions.map((a) => `${a.action}@${a.url ?? ""}`).join(", ") || "(none)"}`,
        `Console errors (${evidence.consoleErrors.length}): ${evidence.consoleErrors.slice(0, 5).join(" | ") || "(none)"}`,
        `Failed requests (${evidence.failedRequests.length}): ${evidence.failedRequests.slice(0, 5).map((r) => `${r.method} ${r.url} [${r.status}]`).join(" | ") || "(none)"}`,
        `Screenshots (${evidence.screenshots.length}): ${evidence.screenshots.join(", ") || "(none)"}`,
      ];
      return { ok: true, output: lines.join("\n") };
    }),
  };
}
