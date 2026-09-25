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

let browserTenantId = "";

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
  if (r.ok !== true) return { ok: false, error: String(r.error ?? "The Workbench Browser refused the command."), meta: r.sessionId ? { browserSessionId: r.sessionId } : undefined };
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
      const url = args.url ? String(args.url) : "";
      const visible = await workbench(context, { op: "open", url });
      if (visible) return sessionResult(visible, `Opened ${url || "a blank tab"} in the Workbench Browser.`);
      const missing = needPlaywright();
      if (missing) return missing;
      const s = await openSession(projectRoot);
      if (url) await gotoWithRecovery(s.page, url);
      s.actions.push({ action: "open", url, timestamp: Date.now() });
      return { ok: true, output: `Browser session started${url ? ` at ${url}` : ""}.\n${BACKGROUND_NOTE}`, meta: backgroundMeta(projectRoot) };
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
      const url = String(args.url);
      const visible = await workbench(context, { op: "navigate", url, sessionId: args.sessionId });
      if (visible) return sessionResult(visible, `Navigated to ${url}.`);
      const missing = needPlaywright();
      if (missing) return missing;
      const page = await getPage(projectRoot);
      const bg = sessions.get(projectRoot);
      // Errors describe the page being looked at: a new page starts clean.
      if (bg) { bg.consoleErrors.length = 0; bg.failedRequests.length = 0; }
      const finalUrl = await gotoWithRecovery(page, url);
      return { ok: true, output: `Now at ${finalUrl} — title: ${await page.title()}\n${BACKGROUND_NOTE}`, meta: backgroundMeta(projectRoot) };
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
    description: "Click an element in the browser session by CSS selector or visible text (text=...).",
    parameters: {
      type: "object",
      properties: { selector: { type: "string" }, sessionId: sessionIdParam },
      required: ["selector"],
    },
    defaultPermission: "ask",
    execute: guard(async (args, context) => {
      const selector = String(args.selector);
      const visible = await workbench(context, { op: "click", selector, sessionId: args.sessionId });
      if (visible) return sessionResult(visible, `Clicked ${selector}.`);
      const missing = needPlaywright();
      if (missing) return missing;
      const page = await getPage(projectRoot);
      await page.click(selector, { timeout: 10_000 });
      return { ok: true, output: `Clicked ${selector}. URL now ${page.url()}\n${BACKGROUND_NOTE}`, meta: backgroundMeta(projectRoot) };
    }),
  };
}

export function makeBrowserTypeTool(projectRoot: string): AITool {
  return {
    name: "browser_type",
    description: "Type text into an input in the browser session (CSS selector), then optionally press Enter.",
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string" },
        text: { type: "string" },
        submit: { type: "boolean", description: "Press Enter afterwards" },
        sessionId: sessionIdParam,
      },
      required: ["selector", "text"],
    },
    defaultPermission: "ask",
    execute: guard(async (args, context) => {
      const selector = String(args.selector);
      const text = String(args.text);
      const visible = await workbench(context, { op: "type", selector, text, sessionId: args.sessionId });
      if (visible) return sessionResult(visible, `Typed into ${selector}.`);
      const missing = needPlaywright();
      if (missing) return missing;
      const page = await getPage(projectRoot);
      await page.fill(selector, text, { timeout: 10_000 });
      if (args.submit === true) await page.press(selector, "Enter");
      return { ok: true, output: `Typed into ${selector}${args.submit ? " and submitted" : ""}.\n${BACKGROUND_NOTE}`, meta: backgroundMeta(projectRoot) };
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
