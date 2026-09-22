// Desktop tools share the Playwright Chromium used by browser_* tools.
// They never bypass ToolGateway. User control pauses agent input.

import { AITool, ToolResult } from "../ToolTypes";
import { playwrightAvailable, PLAYWRIGHT_MISSING, ensureBrowserSession, getBrowserSession, captureBrowserFrame } from "./browserTools";
import {
  beginAgentAction,
  createDesktopSession,
  endAgentAction,
  endDesktopSession,
  getDesktopSession,
  markDesktopError,
  markDesktopReady,
  requestControl,
  type DesktopSession,
} from "../../desktop/desktopSession";

function guard(projectRoot: string, tenantId: string, runId: string | undefined, fn: (session: DesktopSession, args: Record<string, unknown>) => Promise<ToolResult>) {
  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    if (!playwrightAvailable()) return { ok: false, error: PLAYWRIGHT_MISSING };
    const session = getDesktopSession(tenantId, runId, projectRoot) ?? createDesktopSession({ tenantId, projectRoot, runId });
    try {
      return await fn(session, args);
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  };
}

function withAgentLock(session: DesktopSession, run: () => Promise<ToolResult>): Promise<ToolResult> {
  const lock = beginAgentAction(session);
  if (!lock.ok) return Promise.resolve({ ok: false, error: lock.reason });
  return run().finally(() => {
    endAgentAction(session);
  });
}

export function makeDesktopStartTool(projectRoot: string, tenantId: string, runId?: string): AITool {
  return {
    name: "desktop_start",
    description: "Start an isolated ORVYN Desktop session (Chromium in the project sandbox) so the user can watch visual work. Optional url opens that page.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
    },
    defaultPermission: "ask",
    execute: guard(projectRoot, tenantId, runId, async (session, args) => {
      try {
        const browser = await ensureBrowserSession(projectRoot);
        const url = args.url ? String(args.url) : "";
        if (url) await browser.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        markDesktopReady(session, url || String(browser.page.url() || ""));
        return { ok: true, output: `Desktop session ${session.id} ready${session.url ? ` at ${session.url}` : ""}.` };
      } catch (err: any) {
        markDesktopError(session, err.message);
        return { ok: false, error: err.message };
      }
    }),
  };
}

export function makeDesktopOpenUrlTool(projectRoot: string, tenantId: string, runId?: string): AITool {
  return {
    name: "desktop_open_url",
    description: "Open a URL inside the Desktop session browser.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    defaultPermission: "ask",
    execute: guard(projectRoot, tenantId, runId, async (session, args) => {
      return withAgentLock(session, async () => {
        const browser = await ensureBrowserSession(projectRoot);
        await browser.page.goto(String(args.url), { waitUntil: "domcontentloaded", timeout: 30_000 });
        session.url = String(browser.page.url());
        return { ok: true, output: `Desktop opened ${session.url}` };
      });
    }),
  };
}

export function makeDesktopClickTool(projectRoot: string, tenantId: string, runId?: string): AITool {
  return {
    name: "desktop_click",
    description: "Click at desktop coordinates or a CSS selector inside the Desktop browser.",
    parameters: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" }, selector: { type: "string" } },
    },
    defaultPermission: "ask",
    execute: guard(projectRoot, tenantId, runId, async (session, args) => {
      return withAgentLock(session, async () => {
        const page = (await ensureBrowserSession(projectRoot)).page;
        if (args.selector) await page.click(String(args.selector), { timeout: 10_000 });
        else await page.mouse.click(Number(args.x ?? 0), Number(args.y ?? 0));
        return { ok: true, output: `Clicked ${args.selector ?? `${args.x},${args.y}`}` };
      });
    }),
  };
}

export function makeDesktopTypeTool(projectRoot: string, tenantId: string, runId?: string): AITool {
  return {
    name: "desktop_type",
    description: "Type text into the Desktop session. Optional selector focuses an input first.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" }, selector: { type: "string" } },
      required: ["text"],
    },
    defaultPermission: "ask",
    execute: guard(projectRoot, tenantId, runId, async (session, args) => {
      return withAgentLock(session, async () => {
        const page = (await ensureBrowserSession(projectRoot)).page;
        if (args.selector) await page.fill(String(args.selector), String(args.text), { timeout: 10_000 });
        else await page.keyboard.type(String(args.text));
        return { ok: true, output: `Typed ${String(args.text).length} characters.` };
      });
    }),
  };
}

export function makeDesktopScrollTool(projectRoot: string, tenantId: string, runId?: string): AITool {
  return {
    name: "desktop_scroll",
    description: "Scroll the Desktop page. deltaY is pixels (positive = down).",
    parameters: { type: "object", properties: { deltaY: { type: "number" }, x: { type: "number" }, y: { type: "number" } } },
    defaultPermission: "ask",
    execute: guard(projectRoot, tenantId, runId, async (session, args) => {
      return withAgentLock(session, async () => {
        const page = (await ensureBrowserSession(projectRoot)).page;
        await page.mouse.move(Number(args.x ?? 200), Number(args.y ?? 200));
        await page.mouse.wheel(0, Number(args.deltaY ?? 400));
        return { ok: true, output: `Scrolled ${args.deltaY ?? 400}px.` };
      });
    }),
  };
}

export function makeDesktopKeyTool(projectRoot: string, tenantId: string, runId?: string): AITool {
  return {
    name: "desktop_key",
    description: "Press a key in the Desktop session (e.g. Enter, Escape, Control+l).",
    parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    defaultPermission: "ask",
    execute: guard(projectRoot, tenantId, runId, async (session, args) => {
      return withAgentLock(session, async () => {
        const page = (await ensureBrowserSession(projectRoot)).page;
        await page.keyboard.press(String(args.key));
        return { ok: true, output: `Pressed ${args.key}` };
      });
    }),
  };
}

export function makeDesktopScreenshotTool(projectRoot: string, tenantId: string, runId?: string): AITool {
  return {
    name: "desktop_screenshot",
    description: "Capture the current Desktop frame for visual reasoning. Do not call this every action — only when you need to see the screen.",
    parameters: { type: "object", properties: {} },
    defaultPermission: "ask",
    execute: guard(projectRoot, tenantId, runId, async (session) => {
      const frame = await captureBrowserFrame(projectRoot);
      if (!frame) return { ok: false, error: "No Desktop frame. Call desktop_start first." };
      session.lastFrameAt = Date.now();
      session.url = frame.url;
      return { ok: true, output: `Desktop frame ${frame.jpeg.length} bytes at ${frame.url}` };
    }),
  };
}

export function makeDesktopWaitTool(projectRoot: string, tenantId: string, runId?: string): AITool {
  return {
    name: "desktop_wait",
    description: "Wait for the Desktop page to settle (network idle or a CSS selector).",
    parameters: { type: "object", properties: { selector: { type: "string" }, ms: { type: "number" } } },
    defaultPermission: "allowed",
    execute: guard(projectRoot, tenantId, runId, async (session, args) => {
      return withAgentLock(session, async () => {
        const page = getBrowserSession(projectRoot)?.page;
        if (!page) return { ok: false, error: "No Desktop session." };
        if (args.selector) await page.waitForSelector(String(args.selector), { timeout: 15_000 });
        else await page.waitForTimeout(Math.min(8000, Number(args.ms ?? 800)));
        return { ok: true, output: "Desktop ready." };
      });
    }),
  };
}

export function makeDesktopStopTool(projectRoot: string, tenantId: string, runId?: string): AITool {
  return {
    name: "desktop_stop",
    description: "Stop the Desktop session. Does not cancel the mission.",
    parameters: { type: "object", properties: {} },
    defaultPermission: "ask",
    execute: guard(projectRoot, tenantId, runId, async (session) => {
      endDesktopSession(session);
      return { ok: true, output: `Desktop session ${session.id} ended.` };
    }),
  };
}

export function registerDesktopTools(register: (tool: AITool) => void, projectRoot: string, tenantId: string, runId?: string): void {
  register(makeDesktopStartTool(projectRoot, tenantId, runId));
  register(makeDesktopOpenUrlTool(projectRoot, tenantId, runId));
  register(makeDesktopClickTool(projectRoot, tenantId, runId));
  register(makeDesktopTypeTool(projectRoot, tenantId, runId));
  register(makeDesktopScrollTool(projectRoot, tenantId, runId));
  register(makeDesktopKeyTool(projectRoot, tenantId, runId));
  register(makeDesktopScreenshotTool(projectRoot, tenantId, runId));
  register(makeDesktopWaitTool(projectRoot, tenantId, runId));
  register(makeDesktopStopTool(projectRoot, tenantId, runId));
}

export function requestDesktopControl(tenantId: string, projectRoot: string, owner: "user" | "orion", runId?: string) {
  const session = getDesktopSession(tenantId, runId, projectRoot);
  if (!session) return { ok: false as const, error: "No Desktop session." };
  return requestControl(session, owner);
}
