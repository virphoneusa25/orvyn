// Desktop tools: ORION operates the SAME desktop the user sees.
//
// When a Docker sandbox desktop exists for the tenant, every tool drives
// that real X11 desktop via docker exec (frames from `import`, input via
// `xdotool`) — there is no hidden second desktop. The Playwright browser
// path below is the local-dev fallback only, used when the sandbox runtime
// is unavailable.
//
// Ownership is exclusive: when the user owns the session, agent input is
// refused; when ORION owns it, user input is refused by the route layer.
// Tools never bypass ToolGateway.

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
import {
  captureSandboxFrame,
  dockerAvailable,
  findSandboxSession,
  sandboxAgentInput,
  sandboxNavigate,
  startSandboxDesktop,
  stopSandboxDesktop,
  type SandboxDesktopSession,
} from "../../desktop/sandboxDesktop";

function playwrightGuard(projectRoot: string, tenantId: string, runId: string | undefined, fn: (session: DesktopSession, args: Record<string, unknown>) => Promise<ToolResult>) {
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

function sandboxFor(tenantId: string): SandboxDesktopSession | undefined {
  const s = findSandboxSession(tenantId);
  return s && s.status !== "ended" ? s : undefined;
}

function sandboxOwnerError(s: SandboxDesktopSession): ToolResult | null {
  if (s.controlOwner === "user") {
    return { ok: false, error: "User controls this desktop. ORION actions are paused until control returns to ORION." };
  }
  if (s.status !== "ready") {
    return { ok: false, error: `Desktop is ${s.status}.` };
  }
  return null;
}

// ── Sandbox implementations (the REAL desktop) ────────────────────────────

async function sbStart(tenantId: string, projectRoot: string, runId?: string, url?: string): Promise<ToolResult> {
  if (!(await dockerAvailable())) return { ok: false, error: "no-sandbox" };
  try {
    let s = sandboxFor(tenantId);
    if (!s) s = await startSandboxDesktop({ tenantId, projectRoot, runId, url });
    if (s.status === "error") return { ok: false, error: s.error ?? "Desktop failed to start." };
    if (url) await sandboxNavigate(s, url);
    return { ok: true, output: `Desktop session ${s.id} ready (${s.width}×${s.height}).` };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

async function sbAct(tenantId: string, type: string, args: Record<string, unknown>): Promise<ToolResult> {
  const s = sandboxFor(tenantId);
  if (!s) return { ok: false, error: "No Desktop session. Call desktop_start first." };
  const blocked = sandboxOwnerError(s);
  if (blocked) return blocked;
  const ok = await sandboxAgentInput(s, type, { ...args, viewWidth: s.width, viewHeight: s.height });
  return ok
    ? { ok: true, output: `${type} at ${args.x ?? ""}${args.y !== undefined ? "," + args.y : ""}`.trim() }
    : { ok: false, error: "Input injection failed." };
}

// ── Tool factories ────────────────────────────────────────────────────────

export function makeDesktopStartTool(projectRoot: string, tenantId: string, runId?: string): AITool {
  return {
    name: "desktop_start",
    description: "Start an isolated ORVYN Desktop session (a real Linux desktop the user can watch). Optional url opens that page in the desktop Chromium.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
    },
    defaultPermission: "ask",
    execute: async (args) => {
      const sb = await sbStart(tenantId, projectRoot, runId, args.url ? String(args.url) : undefined);
      if (sb.ok || sb.error !== "no-sandbox") return sb;
      // Playwright fallback (local dev without Docker).
      return playwrightGuard(projectRoot, tenantId, runId, async (session, a) => {
        try {
          const browser = await ensureBrowserSession(projectRoot);
          const url = a.url ? String(a.url) : "";
          if (url) await browser.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          markDesktopReady(session, url || String(browser.page.url() || ""));
          return { ok: true, output: `Desktop session ${session.id} ready${session.url ? ` at ${session.url}` : ""}.` };
        } catch (err: any) {
          markDesktopError(session, err.message);
          return { ok: false, error: err.message };
        }
      })(args);
    },
  };
}

export function makeDesktopOpenUrlTool(projectRoot: string, tenantId: string, runId?: string): AITool {
  return {
    name: "desktop_open_url",
    description: "Open a URL inside the Desktop session browser (Chromium on the Linux desktop).",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    defaultPermission: "ask",
    execute: async (args) => {
      const s = sandboxFor(tenantId);
      if (s) {
        const blocked = sandboxOwnerError(s);
        if (blocked) return blocked;
        const ok = await sandboxNavigate(s, String(args.url));
        return ok ? { ok: true, output: `Desktop opened ${args.url}` } : { ok: false, error: "Navigation failed." };
      }
      return playwrightGuard(projectRoot, tenantId, runId, async (session, a) =>
        withAgentLock(session, async () => {
          const browser = await ensureBrowserSession(projectRoot);
          await browser.page.goto(String(a.url), { waitUntil: "domcontentloaded", timeout: 30_000 });
          session.url = String(browser.page.url());
          return { ok: true, output: `Desktop opened ${session.url}` };
        }))(args);
    },
  };
}

export function makeDesktopClickTool(projectRoot: string, tenantId: string, runId?: string): AITool {
  return {
    name: "desktop_click",
    description: "Click at desktop coordinates (remote desktop pixels) or a CSS selector in the desktop browser.",
    parameters: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" }, selector: { type: "string" } },
    },
    defaultPermission: "ask",
    execute: async (args) => {
      if (sandboxFor(tenantId) && !args.selector) {
        return sbAct(tenantId, "click", args);
      }
      return playwrightGuard(projectRoot, tenantId, runId, async (session, a) =>
        withAgentLock(session, async () => {
          const page = (await ensureBrowserSession(projectRoot)).page;
          if (a.selector) await page.click(String(a.selector), { timeout: 10_000 });
          else await page.mouse.click(Number(a.x ?? 0), Number(a.y ?? 0));
          return { ok: true, output: `Clicked ${a.selector ?? `${a.x},${a.y}`}` };
        }))(args);
    },
  };
}

export function makeDesktopMoveTool(projectRoot: string, tenantId: string, runId?: string): AITool {
  return {
    name: "desktop_move",
    description: "Move the pointer to desktop coordinates (remote desktop pixels). The cursor is visible on the live desktop.",
    parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] },
    defaultPermission: "ask",
    execute: async (args) => {
      if (sandboxFor(tenantId)) return sbAct(tenantId, "move", args);
      return playwrightGuard(projectRoot, tenantId, runId, async (session, a) =>
        withAgentLock(session, async () => {
          const page = (await ensureBrowserSession(projectRoot)).page;
          await page.mouse.move(Number(a.x ?? 0), Number(a.y ?? 0));
          return { ok: true, output: `Moved to ${a.x},${a.y}` };
        }))(args);
    },
  };
}

export function makeDesktopTypeTool(projectRoot: string, tenantId: string, runId?: string): AITool {
  return {
    name: "desktop_type",
    description: "Type text into the Desktop session. Optional selector focuses an input first (browser fallback only).",
    parameters: {
      type: "object",
      properties: { text: { type: "string" }, selector: { type: "string" } },
      required: ["text"],
    },
    defaultPermission: "ask",
    execute: async (args) => {
      if (sandboxFor(tenantId) && !args.selector) {
        return sbAct(tenantId, "type", args);
      }
      return playwrightGuard(projectRoot, tenantId, runId, async (session, a) =>
        withAgentLock(session, async () => {
          const page = (await ensureBrowserSession(projectRoot)).page;
          if (a.selector) await page.fill(String(a.selector), String(a.text), { timeout: 10_000 });
          else await page.keyboard.type(String(a.text));
          return { ok: true, output: `Typed ${String(a.text).length} characters.` };
        }))(args);
    },
  };
}

export function makeDesktopScrollTool(projectRoot: string, tenantId: string, runId?: string): AITool {
  return {
    name: "desktop_scroll",
    description: "Scroll at a desktop position. deltaY is pixels (positive = down).",
    parameters: { type: "object", properties: { deltaY: { type: "number" }, x: { type: "number" }, y: { type: "number" } } },
    defaultPermission: "ask",
    execute: async (args) => {
      if (sandboxFor(tenantId)) return sbAct(tenantId, "scroll", args);
      return playwrightGuard(projectRoot, tenantId, runId, async (session, a) =>
        withAgentLock(session, async () => {
          const page = (await ensureBrowserSession(projectRoot)).page;
          await page.mouse.move(Number(a.x ?? 200), Number(a.y ?? 200));
          await page.mouse.wheel(0, Number(a.deltaY ?? 400));
          return { ok: true, output: `Scrolled ${a.deltaY ?? 400}px.` };
        }))(args);
    },
  };
}

export function makeDesktopKeyTool(projectRoot: string, tenantId: string, runId?: string): AITool {
  return {
    name: "desktop_key",
    description: "Press a key in the Desktop session (e.g. Return, Escape, ctrl+l).",
    parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    defaultPermission: "ask",
    execute: async (args) => {
      if (sandboxFor(tenantId)) return sbAct(tenantId, "key", { key: args.key });
      return playwrightGuard(projectRoot, tenantId, runId, async (session, a) =>
        withAgentLock(session, async () => {
          const page = (await ensureBrowserSession(projectRoot)).page;
          await page.keyboard.press(String(a.key));
          return { ok: true, output: `Pressed ${a.key}` };
        }))(args);
    },
  };
}

export function makeDesktopScreenshotTool(projectRoot: string, tenantId: string, runId?: string): AITool {
  return {
    name: "desktop_screenshot",
    description: "Capture the current Desktop frame for visual reasoning. Do not call this every action — only when you need to see the screen.",
    parameters: { type: "object", properties: {} },
    defaultPermission: "ask",
    execute: async (args) => {
      const s = sandboxFor(tenantId);
      if (s) {
        const frame = await captureSandboxFrame(s, "high");
        if (!frame) return { ok: false, error: "No Desktop frame available." };
        s.lastFrameAt = Date.now();
        return {
          ok: true,
          output: `Desktop frame ${frame.length} bytes (${s.width}×${s.height})${s.url ? ` at ${s.url}` : ""}`,
          meta: { sessionId: s.id, screenshot: { b64: frame.toString("base64"), mediaType: "image/jpeg" }, desktopHealthy: true },
        };
      }
      return playwrightGuard(projectRoot, tenantId, runId, async (session) => {
        const frame = await captureBrowserFrame(projectRoot);
        if (!frame) return { ok: false, error: "No Desktop frame. Call desktop_start first." };
        session.lastFrameAt = Date.now();
        session.url = frame.url;
        return {
          ok: true,
          output: `Desktop frame ${frame.jpeg.length} bytes at ${frame.url}`,
          meta: { sessionId: session.id, screenshot: { b64: frame.jpeg.toString("base64"), mediaType: "image/jpeg" }, desktopHealthy: true },
        };
      })(args);
    },
  };
}

export function makeDesktopWaitTool(projectRoot: string, tenantId: string, runId?: string): AITool {
  return {
    name: "desktop_wait",
    description: "Wait for the Desktop to settle (ms, or a CSS selector in the browser fallback).",
    parameters: { type: "object", properties: { selector: { type: "string" }, ms: { type: "number" } } },
    defaultPermission: "allowed",
    execute: async (args) => {
      if (sandboxFor(tenantId)) {
        await new Promise((r) => setTimeout(r, Math.min(8000, Number(args.ms ?? 800))));
        return { ok: true, output: "Desktop ready." };
      }
      return playwrightGuard(projectRoot, tenantId, runId, async (session, a) =>
        withAgentLock(session, async () => {
          const page = getBrowserSession(projectRoot)?.page;
          if (!page) return { ok: false, error: "No Desktop session." };
          if (a.selector) await page.waitForSelector(String(a.selector), { timeout: 15_000 });
          else await page.waitForTimeout(Math.min(8000, Number(a.ms ?? 800)));
          return { ok: true, output: "Desktop ready." };
        }))(args);
    },
  };
}

export function makeDesktopStopTool(projectRoot: string, tenantId: string, runId?: string): AITool {
  return {
    name: "desktop_stop",
    description: "Stop the Desktop session. Does not cancel the mission.",
    parameters: { type: "object", properties: {} },
    defaultPermission: "ask",
    execute: async (args) => {
      const s = sandboxFor(tenantId);
      if (s) {
        await stopSandboxDesktop(s);
        return { ok: true, output: `Desktop session ${s.id} ended.` };
      }
      return playwrightGuard(projectRoot, tenantId, runId, async (session) => {
        endDesktopSession(session);
        return { ok: true, output: `Desktop session ${session.id} ended.` };
      })(args);
    },
  };
}

export function registerDesktopTools(register: (tool: AITool) => void, projectRoot: string, tenantId: string, runId?: string): void {
  register(makeDesktopStartTool(projectRoot, tenantId, runId));
  register(makeDesktopOpenUrlTool(projectRoot, tenantId, runId));
  register(makeDesktopClickTool(projectRoot, tenantId, runId));
  register(makeDesktopMoveTool(projectRoot, tenantId, runId));
  register(makeDesktopTypeTool(projectRoot, tenantId, runId));
  register(makeDesktopScrollTool(projectRoot, tenantId, runId));
  register(makeDesktopKeyTool(projectRoot, tenantId, runId));
  register(makeDesktopScreenshotTool(projectRoot, tenantId, runId));
  register(makeDesktopWaitTool(projectRoot, tenantId, runId));
  register(makeDesktopStopTool(projectRoot, tenantId, runId));
}

export function requestDesktopControl(tenantId: string, projectRoot: string, owner: "user" | "orion", runId?: string) {
  const s = sandboxFor(tenantId);
  if (s) {
    if (s.controlOwner === owner) return { ok: true as const };
    if (owner === "user") { s.controlOwner = "user"; s.status = "user_control"; return { ok: true as const }; }
    if (owner === "orion") { s.controlOwner = "orion"; s.status = "ready"; return { ok: true as const }; }
  }
  const session = getDesktopSession(tenantId, runId, projectRoot);
  if (!session) return { ok: false as const, error: "No Desktop session." };
  return requestControl(session, owner);
}
