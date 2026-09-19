// apps/backend/src/ai/tools/browserTools.ts
//
// Browser QA tools backed by Playwright. Playwright is an OPTIONAL dependency:
// when it is not installed every tool returns the same typed error telling the
// user how to enable it, and the Browser QA agent shows as Pending in the
// roster. No tool pretends to work.

import * as path from "path";
import { promises as fs } from "fs";
import { AITool, ToolResult } from "../ToolTypes";

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
}

// One session per project root; closed when browser_open is called again.
const sessions = new Map<string, BrowserSession>();

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
  const session: BrowserSession = { browser, page, consoleErrors: [] };
  page.on("console", (msg: any) => {
    if (msg.type() === "error") session.consoleErrors.push(`[console.error] ${msg.text()}`.slice(0, 500));
  });
  page.on("pageerror", (err: any) => {
    session.consoleErrors.push(`[pageerror] ${String(err?.message ?? err)}`.slice(0, 500));
  });
  sessions.set(projectRoot, session);
  return session;
}

function guard<T extends Record<string, unknown>>(
  fn: (args: T) => Promise<ToolResult>
): (args: Record<string, unknown>) => Promise<ToolResult> {
  return async (args) => {
    if (!playwrightAvailable()) return { ok: false, error: PLAYWRIGHT_MISSING };
    try {
      return await fn(args as T);
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  };
}

export function makeBrowserOpenTool(projectRoot: string): AITool {
  return {
    name: "browser_open",
    description:
      "Launch a headless browser session (Chromium via Playwright), optionally navigating to a URL. Replaces any prior session for this project.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "URL to open (optional)" } },
    },
    defaultPermission: "ask",
    execute: guard(async (args) => {
      const s = await openSession(projectRoot);
      const url = args.url ? String(args.url) : "";
      if (url) await s.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
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
      const page = await getPage(projectRoot);
      await page.goto(String(args.url), { waitUntil: "domcontentloaded", timeout: 30_000 });
      return { ok: true, output: `Now at ${page.url()} — title: ${await page.title()}` };
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
      const page = await getPage(projectRoot);
      await page.click(String(args.selector), { timeout: 10_000 });
      return { ok: true, output: `Clicked ${args.selector}. URL now ${page.url()}` };
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
      const page = await getPage(projectRoot);
      await page.fill(String(args.selector), String(args.text), { timeout: 10_000 });
      if (args.submit === true) await page.press(String(args.selector), "Enter");
      return { ok: true, output: `Typed into ${args.selector}${args.submit ? " and submitted" : ""}.` };
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
      const page = await getPage(projectRoot);
      const dir = path.join(projectRoot, ".orvyn", "screenshots");
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `shot_${Date.now()}.png`);
      await page.screenshot({ path: file, fullPage: args.fullPage === true });
      return { ok: true, output: `Screenshot saved: ${file}` };
    }),
  };
}
