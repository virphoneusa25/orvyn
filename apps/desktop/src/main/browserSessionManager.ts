// apps/desktop/src/main/browserSessionManager.ts
//
// ONE browser session per ORION run, living in the visible Workbench Browser.
//
// A BrowserSession owns: sessionId, runId, URL, viewport, console errors,
// network errors and screenshots. ORION's browser tools (from the control
// plane, through the Local Worker or the loopback bridge) and the Workbench
// Browser the user looks at operate on the SAME session: the same tab, the
// same page, the same viewport. There is no second, hidden browser here.
//
// Pattern after CoWork-OS Browser V2 (MIT): the main process owns sessions,
// the renderer owns the visible surface. Their implementation is not copied.

import { createHash, randomBytes } from "crypto";
import type { WorkbenchBrowserManager } from "./workbenchBrowser";
import { resolveViewport, VIEWPORT_PRESETS, type BrowserViewport } from "./browserModel";

export interface BrowserConsoleError {
  level: "error" | "warning";
  message: string;
  source?: string;
  line?: number;
  at: number;
}

export interface BrowserNetworkError {
  method: string;
  url: string;
  status: number;
  error?: string;
  at: number;
}

export interface BrowserScreenshot {
  screenshotId: string;
  /** The session this image was taken from. Always the session's id. */
  sessionId: string;
  url: string;
  viewport: BrowserViewport;
  /** Image size in pixels. */
  width: number;
  height: number;
  sha256: string;
  takenAt: number;
}

export interface BrowserSession {
  sessionId: string;
  runId: string;
  /** The Workbench tab this session drives. */
  tabId: string;
  url: string;
  title: string;
  viewport: BrowserViewport;
  consoleErrors: BrowserConsoleError[];
  networkErrors: BrowserNetworkError[];
  screenshots: BrowserScreenshot[];
  createdAt: number;
  updatedAt: number;
  closed?: boolean;
}

export type BrowserCommand =
  | { op: "open"; runId?: string; sessionId?: string; url?: string }
  | { op: "navigate"; runId?: string; sessionId?: string; url: string }
  | { op: "viewport"; runId?: string; sessionId?: string; preset?: string; width?: number; height?: number; mobile?: boolean }
  | { op: "screenshot"; runId?: string; sessionId?: string }
  | { op: "state"; runId?: string; sessionId?: string }
  | { op: "click"; runId?: string; sessionId?: string; selector?: string; x?: number; y?: number }
  | { op: "type"; runId?: string; sessionId?: string; selector?: string; text: string }
  | { op: "scroll"; runId?: string; sessionId?: string; deltaY?: number }
  | { op: "inspect"; runId?: string; sessionId?: string };

export type BrowserCommandResult =
  | ({ ok: true; session: PublicBrowserSession } & Record<string, unknown>)
  | { ok: false; error: string; sessionId?: string };

export type PublicBrowserSession = Omit<BrowserSession, "screenshots"> & { screenshots: BrowserScreenshot[] };

const MAX_SESSIONS = 24;
const MAX_ERRORS = 50;
const MAX_SHOTS = 20;

export class BrowserSessionManager {
  private readonly sessions = new Map<string, BrowserSession>();
  /** PNG bytes by screenshotId (bounded). Metadata lives on the session. */
  private readonly images = new Map<string, Buffer>();

  constructor(private readonly workbench: WorkbenchBrowserManager) {
    workbench.onTabEvent((tabId, event) => this.absorb(tabId, event));
  }

  list(): PublicBrowserSession[] {
    return [...this.sessions.values()].map(publicSession);
  }

  get(sessionId: string): PublicBrowserSession | undefined {
    const s = this.sessions.get(sessionId);
    return s ? publicSession(s) : undefined;
  }

  image(screenshotId: string): Buffer | undefined {
    return this.images.get(screenshotId);
  }

  async handle(raw: unknown): Promise<BrowserCommandResult> {
    const cmd = (raw ?? {}) as BrowserCommand;
    try {
      switch (cmd.op) {
        case "open":
          return await this.open(cmd);
        case "navigate": {
          const s = this.require(cmd);
          await this.workbench.navigate(s.tabId, String(cmd.url ?? ""));
          return this.ok(s);
        }
        case "viewport":
          return await this.setViewport(cmd);
        case "screenshot":
          return await this.screenshot(cmd);
        case "state":
          return this.ok(this.require(cmd));
        case "click": {
          const s = this.require(cmd);
          const r = await this.workbench.click(s.tabId, { selector: cmd.selector, x: cmd.x, y: cmd.y });
          return r.ok ? this.ok(s, { x: r.x, y: r.y }) : { ok: false, error: r.error ?? "click failed", sessionId: s.sessionId };
        }
        case "type": {
          const s = this.require(cmd);
          const r = await this.workbench.type(s.tabId, { selector: cmd.selector, text: String(cmd.text ?? "") });
          return r.ok ? this.ok(s) : { ok: false, error: r.error ?? "type failed", sessionId: s.sessionId };
        }
        case "scroll": {
          const s = this.require(cmd);
          await this.workbench.scroll(s.tabId, Number(cmd.deltaY ?? 400));
          return this.ok(s);
        }
        case "inspect": {
          const s = this.require(cmd);
          const r = await this.workbench.inspect(s.tabId);
          return this.ok(s, { outline: r.outline ?? "" });
        }
        default:
          return { ok: false, error: `Unknown browser command "${String((cmd as { op?: string }).op)}"` };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), sessionId: cmd.sessionId };
    }
  }

  /** Opens (or reuses) the run's session and shows it in the Workbench. */
  private async open(cmd: Extract<BrowserCommand, { op: "open" }>): Promise<BrowserCommandResult> {
    const existing = this.find(cmd);
    if (existing && !existing.closed && this.workbench.hasTab(existing.tabId)) {
      if (cmd.url) await this.workbench.navigate(existing.tabId, cmd.url);
      this.workbench.reveal(existing.tabId);
      return this.ok(existing);
    }
    const sessionId = `bs_${randomBytes(6).toString("hex")}`;
    const tabId = await this.workbench.createSessionTab(sessionId, cmd.url);
    const now = Date.now();
    const session: BrowserSession = {
      sessionId,
      runId: String(cmd.runId ?? ""),
      tabId,
      url: "",
      title: "",
      viewport: { ...VIEWPORT_PRESETS.desktop },
      consoleErrors: [],
      networkErrors: [],
      screenshots: [],
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(sessionId, session);
    this.trim();
    this.syncFromTab(session);
    this.workbench.reveal(tabId);
    return this.ok(session);
  }

  private async setViewport(cmd: Extract<BrowserCommand, { op: "viewport" }>): Promise<BrowserCommandResult> {
    const s = this.require(cmd);
    const viewport = resolveViewport(cmd);
    if (!viewport) return { ok: false, error: 'Viewport must be "desktop", "tablet", "mobile", or a width and height between 240 and 3840.', sessionId: s.sessionId };
    const applied = await this.workbench.setTabViewport(s.tabId, viewport);
    s.viewport = viewport;
    s.updatedAt = Date.now();
    this.workbench.reveal(s.tabId);
    return this.ok(s, { applied });
  }

  private async screenshot(cmd: Extract<BrowserCommand, { op: "screenshot" }>): Promise<BrowserCommandResult> {
    const s = this.require(cmd);
    const shot = await this.workbench.capture(s.tabId);
    if (!shot) return { ok: false, error: "The Workbench tab could not be captured.", sessionId: s.sessionId };
    this.syncFromTab(s);
    const record: BrowserScreenshot = {
      screenshotId: `shot_${randomBytes(5).toString("hex")}`,
      sessionId: s.sessionId,
      url: s.url,
      viewport: { ...s.viewport },
      width: shot.width,
      height: shot.height,
      sha256: createHash("sha256").update(shot.png).digest("hex"),
      takenAt: Date.now(),
    };
    s.screenshots.push(record);
    this.images.set(record.screenshotId, shot.png);
    while (s.screenshots.length > MAX_SHOTS) {
      const old = s.screenshots.shift();
      if (old) this.images.delete(old.screenshotId);
    }
    s.updatedAt = record.takenAt;
    return this.ok(s, { screenshot: record, png: shot.png.toString("base64") });
  }

  private ok(s: BrowserSession, extra: Record<string, unknown> = {}): BrowserCommandResult {
    this.syncFromTab(s);
    return { ok: true, session: publicSession(s), ...extra };
  }

  private find(cmd: { sessionId?: string; runId?: string }): BrowserSession | undefined {
    if (cmd.sessionId) return this.sessions.get(String(cmd.sessionId));
    if (!cmd.runId) return undefined;
    return [...this.sessions.values()].filter((s) => s.runId === cmd.runId && !s.closed).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  private require(cmd: { sessionId?: string; runId?: string }): BrowserSession {
    const s = this.find(cmd);
    if (!s) throw new Error(cmd.sessionId ? `Unknown browser session ${cmd.sessionId}.` : "No browser session for this run. Call browser_open first.");
    if (s.closed || !this.workbench.hasTab(s.tabId)) {
      s.closed = true;
      throw new Error(`Browser session ${s.sessionId} was closed in the Workbench. Call browser_open to start a new one.`);
    }
    return s;
  }

  private syncFromTab(s: BrowserSession): void {
    const tab = this.workbench.tabInfo(s.tabId);
    if (!tab) return;
    s.url = tab.url || s.url;
    s.title = tab.title || s.title;
  }

  /** Console and network errors arrive per tab; they belong to that tab's session. */
  private absorb(tabId: string, event: { kind: "console"; entry: BrowserConsoleError } | { kind: "network"; entry: BrowserNetworkError } | { kind: "closed" }): void {
    for (const s of this.sessions.values()) {
      if (s.tabId !== tabId) continue;
      if (event.kind === "closed") s.closed = true;
      else if (event.kind === "console") {
        s.consoleErrors.push(event.entry);
        if (s.consoleErrors.length > MAX_ERRORS) s.consoleErrors.shift();
      } else {
        s.networkErrors.push(event.entry);
        if (s.networkErrors.length > MAX_ERRORS) s.networkErrors.shift();
      }
      s.updatedAt = Date.now();
    }
  }

  private trim(): void {
    const all = [...this.sessions.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    while (all.length > MAX_SESSIONS) {
      const old = all.shift()!;
      for (const shot of old.screenshots) this.images.delete(shot.screenshotId);
      this.sessions.delete(old.sessionId);
    }
  }
}

function publicSession(s: BrowserSession): PublicBrowserSession {
  return {
    ...s,
    viewport: { ...s.viewport },
    consoleErrors: s.consoleErrors.slice(-20),
    networkErrors: s.networkErrors.slice(-20),
    screenshots: s.screenshots.map((x) => ({ ...x })),
  };
}
