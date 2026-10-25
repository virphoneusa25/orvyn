// apps/backend/src/ai/tools/browserTools.ts
//
// Browser QA tools backed by Playwright. Playwright is an OPTIONAL dependency:
// when it is not installed every tool returns the same typed error telling the
// user how to enable it, and the Browser QA agent shows as Pending in the
// roster. No tool pretends to work.

import * as path from "path";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import { AITool, ToolExecutionContext, ToolResult } from "../ToolTypes";
import { workbenchBrowserCommand } from "../../desktop/electronBrowserTarget";
import { invalidPreviewUrlResult, resolveNavigationTarget } from "../../agent/previewTarget";

let browserTenantId = "";

/**
 * Canonical-preview navigation rule (same resolver as the runtime guard): a
 * browser verification target must be an absolute http(s) URL. A file name
 * like "index.html" is redirected to the run's live preview URL when one
 * exists, otherwise the call fails structurally — it is never typed into a
 * browser.
 */
function checkNavigationTarget(raw: unknown, context?: ToolExecutionContext): { ok: true; url: string; redirectedFrom?: string } | { ok: false; result: ToolResult } {
  const resolution = resolveNavigationTarget(String(context?.runId ?? ""), raw, { allowFile: true });
  if (resolution.ok) return resolution;
  return { ok: false, result: invalidPreviewUrlResult(resolution) };
}

export function setBrowserToolTenant(tenantId: string): void {
  browserTenantId = tenantId;
}

interface WorkbenchSession {
  sessionId: string;
  runId: string;
  url: string;
  title: string;
  viewport: { preset: string; width: number; height: number; mobile: boolean };
  consoleErrors: { level: string; message: string; source?: string; line?: number }[];
  networkErrors: { method: string; url: string; status: number; error?: string }[];
  screenshots: { screenshotId: string; sessionId: string; width: number; height: number; sha256: string; url: string }[];
}

/**
 * One command to the Workbench Browser session the user is looking at.
 * null: no Workbench Browser is connected (the hidden Playwright fallback
 * applies, and says so). Every visible command carries the run id, so the
 * desktop keeps one session per run.
 */
async function workbench(context: ToolExecutionContext | undefined, command: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const tenantId = context?.tenantId || browserTenantId;
  return workbenchBrowserCommand(tenantId, { ...command, op: String(command.op), runId: context?.runId });
}

function viewportLabel(v: WorkbenchSession["viewport"]): string {
  const name = v.preset === "custom" ? "Custom" : v.preset[0]!.toUpperCase() + v.preset.slice(1);
  return `${name} ${v.width}×${v.height}${v.mobile ? " (mobile)" : ""}`;
}

/** The tool result for a visible-session command: the session id is always in it. */
function sessionResult(r: Record<string, unknown>, summary: string, extraLines: string[] = [], meta: Record<string, unknown> = {}): ToolResult {
  if (r.ok !== true) {
    const error = String(r.error ?? "The Workbench Browser refused the command.");
    // Tell the model what to do instead of retrying the same call in a loop.
    const hint = /did not answer|not ready|not attached/i.test(error)
      ? " The Workbench Browser is busy or unavailable right now. Do not retry the browser in a loop: to check page content (a title, a heading, text), read the project's source files, or fetch the URL with an HTTP tool."
      : /No browser session|Unknown browser session|was closed in the Workbench/i.test(error)
        ? " Call browser_open with the URL first (without a sessionId), then use the browserSessionId it returns."
        : "";
    return { ok: false, error: error + hint, meta: r.sessionId ? { browserSessionId: r.sessionId } : undefined };
  }
  const s = r.session as WorkbenchSession;
  return {
    ok: true,
    output: [
      summary,
      `browserSessionId: ${s.sessionId}`,
      `URL: ${s.url || "(blank)"}${s.title ? ` — ${s.title}` : ""}`,
      `Viewport: ${viewportLabel(s.viewport)}`,
      ...extraLines,
      "Surface: ORVYN Workbench Browser (the user sees this same page)",
    ].join("\n"),
    meta: {
      browserSessionId: s.sessionId,
      browserSession: {
        sessionId: s.sessionId,
        runId: s.runId,
        url: s.url,
        title: s.title,
        viewport: s.viewport,
        consoleErrors: s.consoleErrors.length,
        networkErrors: s.networkErrors.length,
        screenshots: s.screenshots.length,
      },
      surface: "workbench",
      ...meta,
    },
  };
}

/** The server-side fallback session, described like a Workbench session (surface: background). */
function backgroundMeta(projectRoot: string): Record<string, unknown> {
  const s = sessions.get(projectRoot);
  const id = `bg_${createHash("sha1").update(projectRoot).digest("hex").slice(0, 10)}`;
  const size = s?.page?.viewportSize?.() as { width: number; height: number } | null | undefined;
  return {
    surface: "background",
    browserSessionId: id,
    browserSession: {
      sessionId: id,
      runId: "",
      url: s ? String(s.page.url()) : "",
      title: "",
      viewport: size ? { preset: "custom", width: size.width, height: size.height, mobile: false } : undefined,
      consoleErrors: s?.consoleErrors.length ?? 0,
      networkErrors: s?.failedRequests.length ?? 0,
      screenshots: s?.screenshots.length ?? 0,
    },
  };
}

const BACKGROUND_NOTE = "Surface: background browser on the server (no ORVYN Desktop connected), not visible to the user.";

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
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });
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
  fn: (args: T, context?: ToolExecutionContext) => Promise<ToolResult>,
  opts?: { playwright?: boolean }
): (args: Record<string, unknown>, context?: ToolExecutionContext) => Promise<ToolResult> {
  return async (args, context) => {
    try {
      return await fn(args as T, context);
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

function appendRedirectNote(result: ToolResult, redirectedFrom?: string): ToolResult {
  if (!redirectedFrom || !result.ok) return result;
  const note = `\n[Navigation guard] "${redirectedFrom}" is not a URL; the run's live preview URL was used instead. Always navigate to that absolute URL.`;
  return { ...result, output: `${String(result.output ?? "")}${note}` };
}

const sessionIdParam = { type: "string", description: "browserSessionId from browser_open (optional: defaults to this run's session)" };

export function makeBrowserOpenTool(projectRoot: string): AITool {
  return {
    name: "browser_open",
    description:
      "Open a URL in the ORVYN Workbench Browser the user is watching. Returns the browserSessionId that every other browser tool acts on. Reuses this run's session if it has one.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "URL or domain to open" } },
    },
    defaultPermission: "ask",
    execute: guard(async (args, context) => {
      const nav = checkNavigationTarget(args.url, context);
      if (!nav.ok) return nav.result;
      const url = nav.url;
      const visible = await workbench(context, { op: "open", url });
      if (visible) return appendRedirectNote(sessionResult(visible, `Opened ${url || "a blank tab"} in the Workbench Browser.`), nav.redirectedFrom);
      const missing = needPlaywright();
      if (missing) return missing;
      const s = await openSession(projectRoot);
      if (url) await gotoWithRecovery(s.page, url);
      s.actions.push({ action: "open", url, timestamp: Date.now() });
      return appendRedirectNote({ ok: true, output: `Browser session started${url ? ` at ${url}` : ""}.\n${BACKGROUND_NOTE}`, meta: backgroundMeta(projectRoot) }, nav.redirectedFrom);
    }),
  };
}

export function makeBrowserNavigateTool(projectRoot: string): AITool {
  return {
    name: "browser_navigate",
    description: "Navigate the browser session to a URL and report the page title.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" }, sessionId: sessionIdParam },
      required: ["url"],
    },
    defaultPermission: "ask",
    execute: guard(async (args, context) => {
      const nav = checkNavigationTarget(args.url, context);
      if (!nav.ok) return nav.result;
      const url = nav.url;
      const visible = await workbench(context, { op: "navigate", url, sessionId: args.sessionId });
      if (visible) return appendRedirectNote(sessionResult(visible, `Navigated to ${url}.`), nav.redirectedFrom);
      const missing = needPlaywright();
      if (missing) return missing;
      const page = await getPage(projectRoot);
      const bg = sessions.get(projectRoot);
      // Errors describe the page being looked at: a new page starts clean.
      if (bg) { bg.consoleErrors.length = 0; bg.failedRequests.length = 0; }
      const finalUrl = await gotoWithRecovery(page, url);
      return appendRedirectNote({ ok: true, output: `Now at ${finalUrl} — title: ${await page.title()}\n${BACKGROUND_NOTE}`, meta: backgroundMeta(projectRoot) }, nav.redirectedFrom);
    }),
  };
}

export function makeBrowserViewportTool(projectRoot: string): AITool {
  return {
    name: "browser_set_viewport",
    description:
      'Resize the browser session to test responsive layouts: preset "desktop" (1280×800), "tablet" (820×1180) or "mobile" (390×844), or an explicit width and height. The user sees the same page resize.',
    parameters: {
      type: "object",
      properties: {
        preset: { type: "string", enum: ["desktop", "tablet", "mobile"] },
        width: { type: "number" },
        height: { type: "number" },
        mobile: { type: "boolean" },
        sessionId: sessionIdParam,
      },
    },
    defaultPermission: "ask",
    execute: guard(async (args, context) => {
      const visible = await workbench(context, { op: "viewport", preset: args.preset, width: args.width, height: args.height, mobile: args.mobile, sessionId: args.sessionId });
      if (visible) {
        const applied = visible.applied as { width?: number; height?: number; innerWidth?: number; innerHeight?: number } | undefined;
        const line = applied ? [`Page now lays out at ${applied.innerWidth ?? applied.width}×${applied.innerHeight ?? applied.height} CSS px in the Workbench.`] : [];
        return sessionResult(visible, "Viewport changed.", line, { viewportApplied: applied });
      }
      const missing = needPlaywright();
      if (missing) return missing;
      const presets: Record<string, [number, number]> = { desktop: [1280, 800], tablet: [820, 1180], mobile: [390, 844] };
      const [w, h] = presets[String(args.preset ?? "")] ?? [Number(args.width) || 1280, Number(args.height) || 800];
      const page = await getPage(projectRoot);
      await page.setViewportSize({ width: w, height: h });
      return { ok: true, output: `Viewport set to ${w}×${h}.\n${BACKGROUND_NOTE}`, meta: backgroundMeta(projectRoot) };
    }),
  };
}

export function makeBrowserClickTool(projectRoot: string): AITool {
  return {
    name: "browser_click",
    description: "Click an element in the browser session by ref (@e1, @e2), CSS selector, visible text (text=...), or coordinate.",
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector, element ref (@e1, @e2), or text=..." },
        target: { type: "string", description: "Element ref (e.g. @e1) or CSS selector" },
        x: { type: "number", description: "Optional x coordinate" },
        y: { type: "number", description: "Optional y coordinate" },
        sessionId: sessionIdParam,
      },
    },
    defaultPermission: "ask",
    execute: guard(async (args, context) => {
      const target = String(args.target ?? args.selector ?? "");
      const visible = await workbench(context, { op: "click", selector: target, target, x: args.x, y: args.y, sessionId: args.sessionId });
      if (visible) return sessionResult(visible, `Clicked ${target || `${args.x},${args.y}`}.`);
      const missing = needPlaywright();
      if (missing) return missing;
      const page = await getPage(projectRoot);
      let sel = target;
      if (/^@e\d+$/i.test(sel)) {
        sel = `[data-orvyn-ref="${sel.toLowerCase()}"]`;
      }
      if (args.x !== undefined && args.y !== undefined) {
        await page.mouse.click(Number(args.x), Number(args.y));
      } else {
        if (!sel) return { ok: false, error: "target, selector, or x/y coordinate is required for browser_click" };
        await page.click(sel, { timeout: 10_000 });
      }
      return { ok: true, output: `Clicked ${target || `${args.x},${args.y}`}. URL now ${page.url()}\n${BACKGROUND_NOTE}`, meta: backgroundMeta(projectRoot) };
    }),
  };
}

export function makeBrowserTypeTool(projectRoot: string): AITool {
  return {
    name: "browser_type",
    description: "Type text into an input in the browser session (element ref @e1 or CSS selector), then optionally press Enter.",
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector or element ref (@e1)" },
        target: { type: "string", description: "Element ref (@e1) or CSS selector" },
        text: { type: "string" },
        value: { type: "string" },
        submit: { type: "boolean", description: "Press Enter afterwards" },
        sessionId: sessionIdParam,
      },
      required: ["text"],
    },
    defaultPermission: "ask",
    execute: guard(async (args, context) => {
      const target = String(args.target ?? args.selector ?? "");
      const text = String(args.value ?? args.text ?? "");
      const visible = await workbench(context, { op: "type", selector: target, target, text, value: text, submit: args.submit, sessionId: args.sessionId });
      if (visible) return sessionResult(visible, `Typed into ${target}.`);
      const missing = needPlaywright();
      if (missing) return missing;
      const page = await getPage(projectRoot);
      let sel = target;
      if (/^@e\d+$/i.test(sel)) {
        sel = `[data-orvyn-ref="${sel.toLowerCase()}"]`;
      }
      if (!sel) return { ok: false, error: "target or selector is required for browser_type" };
      await page.fill(sel, text, { timeout: 10_000 });
      if (args.submit === true) await page.press(sel, "Enter");
      return { ok: true, output: `Typed into ${target}${args.submit ? " and submitted" : ""}.\n${BACKGROUND_NOTE}`, meta: backgroundMeta(projectRoot) };
    }),
  };
}

export function makeBrowserFillTool(projectRoot: string): AITool {
  return {
    name: "browser_fill",
    description: "Fill text into an input or textarea element by element ref (e.g. @e1, @e2) or CSS selector, optionally pressing Enter.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "Element ref (@e1, @e2) or CSS selector" },
        selector: { type: "string", description: "Alternative selector" },
        value: { type: "string", description: "Text value to fill" },
        text: { type: "string", description: "Alternative text to fill" },
        submit: { type: "boolean", description: "Press Enter afterwards" },
        sessionId: sessionIdParam,
      },
    },
    defaultPermission: "ask",
    execute: guard(async (args, context) => {
      const target = String(args.target ?? args.selector ?? "");
      const val = String(args.value ?? args.text ?? "");
      const visible = await workbench(context, { op: "fill", selector: target, target, value: val, submit: args.submit, sessionId: args.sessionId });
      if (visible) return sessionResult(visible, `Filled ${target} with "${val}".`);
      const missing = needPlaywright();
      if (missing) return missing;
      const page = await getPage(projectRoot);
      let sel = target;
      if (/^@e\d+$/i.test(sel)) {
        sel = `[data-orvyn-ref="${sel.toLowerCase()}"]`;
      }
      if (!sel) return { ok: false, error: "target or selector is required for browser_fill" };
      await page.fill(sel, val, { timeout: 10_000 });
      if (args.submit === true) await page.press(sel, "Enter");
      return { ok: true, output: `Filled ${target} with "${val}"${args.submit ? " and submitted" : ""}.\n${BACKGROUND_NOTE}`, meta: backgroundMeta(projectRoot) };
    }),
  };
}

export function makeBrowserSnapshotTool(projectRoot: string): AITool {
  return {
    name: "browser_snapshot",
    description: "Get a compact accessibility and interactive element snapshot (@e1, @e2, ...) of the current page. Much lighter and faster than full DOM inspection.",
    parameters: {
      type: "object",
      properties: { sessionId: sessionIdParam },
    },
    defaultPermission: "allowed",
    execute: guard(async (args, context) => {
      const visible = await workbench(context, { op: "snapshot", sessionId: args.sessionId });
      if (visible) return sessionResult(visible, "Browser snapshot:");
      const missing = needPlaywright();
      if (missing) return missing;
      const page = await getPage(projectRoot);
      const snap = await page.evaluate(() => {
        const isVisible = (el: Element) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
        };
        const interactive = Array.from(document.querySelectorAll(
          'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [tabindex="0"]'
        )).filter(isVisible).slice(0, 60);

        const elements = interactive.map((el, i) => {
          const ref = "@e" + (i + 1);
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "button" ? "button" : (el as HTMLInputElement).type || tag);
          const name = ((el as HTMLElement).innerText || el.getAttribute("aria-label") || (el as HTMLInputElement).placeholder || (el as HTMLInputElement).value || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 80);
          const href = el.getAttribute("href") || undefined;
          el.setAttribute("data-orvyn-ref", ref);
          return { ref, role, name, href };
        });

        const lines = elements.map(e => `[${e.ref}] ${e.role} "${e.name}"${e.href ? ` -> ${e.href}` : ""}`);
        return { elements, treeText: lines.join("\n") };
      }).catch(() => ({ elements: [], treeText: "" }));

      const output = [
        `Page: ${page.url()} — Title: "${await page.title().catch(() => "")}"`,
        `Interactive Elements (${snap.elements.length} found):`,
        snap.treeText || "(No interactive elements detected on this page)",
        `Tip: Target elements using refs in browser_click or browser_fill (e.g. target: "@e1").`,
        BACKGROUND_NOTE,
      ].join("\n\n");

      return {
        ok: true,
        output,
        meta: {
          ...backgroundMeta(projectRoot),
          interactiveCount: snap.elements.length,
          tree: snap.treeText,
        },
      };
    }),
  };
}

export function makeBrowserTabsTool(projectRoot: string): AITool {
  return {
    name: "browser_tabs",
    description: "List all open browser tabs and identify the currently active tab.",
    parameters: { type: "object", properties: { sessionId: sessionIdParam } },
    defaultPermission: "allowed",
    execute: guard(async (args, context) => {
      const visible = await workbench(context, { op: "tabs", sessionId: args.sessionId });
      if (visible) return sessionResult(visible, "Browser tabs:");
      const missing = needPlaywright();
      if (missing) return missing;
      const s = sessions.get(projectRoot);
      if (!s) return { ok: false, error: "No browser session. Call browser_open first." };
      const pages = s.page.context().pages();
      const tabList = await Promise.all(pages.map(async (p: any, idx: number) => ({
        index: idx,
        url: p.url(),
        title: await p.title().catch(() => ""),
        active: p === s.page,
      })));
      const lines = tabList.map((t: any) => `Tab [${t.index}] ${t.active ? "(active) " : ""}${t.title} — ${t.url}`);
      return { ok: true, output: lines.join("\n") + "\n" + BACKGROUND_NOTE, meta: backgroundMeta(projectRoot) };
    }),
  };
}

export function makeBrowserSwitchTabTool(projectRoot: string): AITool {
  return {
    name: "browser_switch_tab",
    description: "Switch active browser tab by tab index (0-based).",
    parameters: {
      type: "object",
      properties: { index: { type: "number", description: "0-based tab index" }, sessionId: sessionIdParam },
      required: ["index"],
    },
    defaultPermission: "ask",
    execute: guard(async (args, context) => {
      const idx = Number(args.index ?? 0);
      const visible = await workbench(context, { op: "switch_tab", index: idx, sessionId: args.sessionId });
      if (visible) return sessionResult(visible, `Switched to tab ${idx}.`);
      const missing = needPlaywright();
      if (missing) return missing;
      const s = sessions.get(projectRoot);
      if (!s) return { ok: false, error: "No browser session. Call browser_open first." };
      const pages = s.page.context().pages();
      if (idx < 0 || idx >= pages.length) return { ok: false, error: `Invalid tab index: ${idx}. Open tabs: ${pages.length}` };
      s.page = pages[idx];
      await s.page.bringToFront();
      return { ok: true, output: `Switched to tab ${idx} (${s.page.url()})\n${BACKGROUND_NOTE}`, meta: backgroundMeta(projectRoot) };
    }),
  };
}

export function makeBrowserNetworkErrorsTool(projectRoot: string): AITool {
  return {
    name: "browser_network_errors",
    description: "Report failed network requests (HTTP 4xx/5xx or blocked connections) encountered by the browser.",
    parameters: { type: "object", properties: { sessionId: sessionIdParam } },
    defaultPermission: "allowed",
    execute: guard(async (args, context) => {
      const visible = await workbench(context, { op: "network_errors", sessionId: args.sessionId });
      if (visible) return sessionResult(visible, "Browser network errors:");
      const missing = needPlaywright();
      if (missing) return missing;
      const s = sessions.get(projectRoot);
      if (!s) return { ok: false, error: "No browser session. Call browser_open first." };
      const lines = s.failedRequests.map(r => `[network] ${r.method} ${r.url} [${r.status}]`);
      return {
        ok: true,
        output: lines.length ? lines.join("\n") + "\n" + BACKGROUND_NOTE : "No network errors observed.\n" + BACKGROUND_NOTE,
        meta: backgroundMeta(projectRoot),
      };
    }),
  };
}

export function makeBrowserConsoleErrorsTool(projectRoot: string): AITool {
  return {
    name: "browser_console_errors",
    description:
      "Report the console errors, uncaught page errors and failed network requests collected in the browser session. Empty means none were observed.",
    parameters: { type: "object", properties: { sessionId: sessionIdParam } },
    defaultPermission: "allowed",
    execute: guard(async (args, context) => {
      const visible = await workbench(context, { op: "state", sessionId: args.sessionId });
      if (visible) {
        const s = visible.session as WorkbenchSession | undefined;
        const lines = [
          ...(s?.consoleErrors ?? []).map((c) => `[console.${c.level}] ${c.message}${c.source ? ` (${c.source}${c.line ? `:${c.line}` : ""})` : ""}`),
          ...(s?.networkErrors ?? []).map((n) => `[network] ${n.method} ${n.url} ${n.status || n.error || ""}`),
        ];
        return sessionResult(visible, lines.length ? `${lines.length} problem(s) observed:` : "No console, page or network errors observed.", lines);
      }
      const missing = needPlaywright();
      if (missing) return missing;
      const s = sessions.get(projectRoot);
      if (!s) return { ok: false, error: "No browser session. Call browser_open first." };
      const failed = s.failedRequests.map((r) => `[network] ${r.method} ${r.url} ${r.status || "failed"}`);
      const all = [...s.consoleErrors, ...failed];
      return {
        ok: true,
        output: `${all.length === 0 ? "No console, page or network errors observed." : all.join("\n")}\n${BACKGROUND_NOTE}`,
        meta: backgroundMeta(projectRoot),
      };
    }),
  };
}

export function makeBrowserScreenshotTool(projectRoot: string): AITool {
  return {
    name: "browser_screenshot",
    description:
      "Screenshot the browser session exactly as the user sees it (at its current viewport). Returns a screenshot id tied to the browserSessionId and the image for inspection.",
    parameters: {
      type: "object",
      properties: { fullPage: { type: "boolean" }, sessionId: sessionIdParam },
    },
    defaultPermission: "ask",
    execute: guard(async (args, context) => {
      const visible = await workbench(context, { op: "screenshot", sessionId: args.sessionId });
      if (visible) {
        if (visible.ok !== true) return sessionResult(visible, "");
        const shot = visible.screenshot as WorkbenchSession["screenshots"][number] & { viewport?: WorkbenchSession["viewport"] };
        return sessionResult(
          visible,
          `Screenshot ${shot.screenshotId} taken.`,
          [`Screenshot: ${shot.screenshotId} · ${shot.width}×${shot.height}px · session ${shot.sessionId} · sha256 ${shot.sha256.slice(0, 12)}…`],
          {
            screenshot: typeof visible.png === "string" ? { b64: visible.png, mediaType: "image/png" } : undefined,
            browserScreenshot: shot,
            desktopHealthy: true,
          }
        );
      }
      const dir = path.join(projectRoot, ".orvyn", "screenshots");
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `shot_${Date.now()}.png`);
      const missing = needPlaywright();
      if (missing) return missing;
      const page = await getPage(projectRoot);
      await page.screenshot({ path: file, fullPage: args.fullPage === true });
      const s = sessions.get(projectRoot);
      if (s) {
        s.screenshots.push(file);
        s.actions.push({ action: "screenshot", url: page.url(), timestamp: Date.now(), result: file });
      }
      return { ok: true, output: `Screenshot saved: ${file}\n${BACKGROUND_NOTE}`, meta: backgroundMeta(projectRoot) };
    }),
  };
}

export function makeBrowserScrollTool(projectRoot: string): AITool {
  return {
    name: "browser_scroll",
    description: "Scroll the browser session by a pixel delta.",
    parameters: {
      type: "object",
      properties: { deltaY: { type: "number", description: "Positive scrolls down" }, sessionId: sessionIdParam },
    },
    defaultPermission: "ask",
    execute: guard(async (args, context) => {
      const deltaY = Number(args.deltaY ?? 400);
      const visible = await workbench(context, { op: "scroll", deltaY, sessionId: args.sessionId });
      if (visible) return sessionResult(visible, `Scrolled by ${deltaY}px.`);
      const missing = needPlaywright();
      if (missing) return missing;
      const page = await getPage(projectRoot);
      await page.mouse.wheel(0, deltaY);
      return { ok: true, output: `Scrolled by ${deltaY}px.\n${BACKGROUND_NOTE}`, meta: backgroundMeta(projectRoot) };
    }),
  };
}

export function makeBrowserEvidenceTool(projectRoot: string): AITool {
  return {
    name: "browser_evidence",
    description:
      "Get the browser session evidence: session id, URL, viewport, console errors, failed network requests and screenshots. Use for verification reports.",
    parameters: { type: "object", properties: { sessionId: sessionIdParam } },
    defaultPermission: "allowed",
    execute: guard(async (args, context) => {
      const visible = await workbench(context, { op: "state", sessionId: args.sessionId });
      if (visible) {
        const s = visible.session as WorkbenchSession | undefined;
        return sessionResult(visible, "Browser session evidence:", s ? [
          `Console errors (${s.consoleErrors.length}): ${s.consoleErrors.slice(-5).map((c) => c.message).join(" | ") || "(none)"}`,
          `Network errors (${s.networkErrors.length}): ${s.networkErrors.slice(-5).map((n) => `${n.method} ${n.url} [${n.status || n.error}]`).join(" | ") || "(none)"}`,
          `Screenshots (${s.screenshots.length}): ${s.screenshots.map((x) => `${x.screenshotId} ${x.width}×${x.height}`).join(", ") || "(none)"}`,
        ] : []);
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
        BACKGROUND_NOTE,
      ];
      return { ok: true, output: lines.join("\n"), meta: backgroundMeta(projectRoot) };
    }),
  };
}
