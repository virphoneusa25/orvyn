import { browserSessionService, BrowserSessionService } from "./BrowserSessionService";
import { desktopSessionService, DesktopSessionService } from "./DesktopSessionService";
import type { ComputerSurface, ComputerUseRequest, ComputerUseResult } from "./types";

/**
 * ORVYN-owned computer-use. Model providers only emit tool calls; this
 * module talks to DesktopSessionService / BrowserSessionService.
 */
export class ComputerUseCapability {
  constructor(
    private desktop: DesktopSessionService = desktopSessionService,
    private browser: BrowserSessionService = browserSessionService
  ) {}

  resolveSurface(req: ComputerUseRequest): ComputerSurface {
    if (req.surface && req.surface !== "auto") return req.surface;
    if (req.identity.browserSessionId) return "browser";
    if (this.desktop.sandbox(req.identity) || req.identity.desktopSessionId) return "desktop";
    if (this.desktop.hostAllowed(req.identity.tenantId)) return "host";
    if (this.browser.getSession(req.identity.projectRoot)) return "browser";
    return "desktop";
  }

  /** After Return to ORION — inspect the actual current frame, not a stale one. */
  async refreshAfterReturn(req: ComputerUseRequest): Promise<ComputerUseResult> {
    return this.screenshot(req, this.resolveSurface(req));
  }

  async act(req: ComputerUseRequest): Promise<ComputerUseResult> {
    const surface = this.resolveSurface(req);
    if (req.action === "screenshot") return this.screenshot(req, surface);
    if (req.action === "wait") {
      await new Promise((r) => setTimeout(r, Math.min(8000, Number(req.ms ?? 600))));
      return { ok: true, output: "Waited.", desktopHealthy: true, surface, sessionId: this.sessionId(req, surface) };
    }
    if (req.action === "open_app") {
      const opened = await this.desktop.openApp(req.identity, String(req.app ?? "xterm"));
      return {
        ok: opened.ok,
        output: opened.ok ? `Opened ${req.app}` : undefined,
        error: opened.error,
        desktopHealthy: true,
        surface: "desktop",
        sessionId: opened.sessionId,
      };
    }
    if (req.action === "focus_window") {
      const windows = this.desktop.getWindows(req.identity);
      return {
        ok: windows.length > 0,
        output: windows.length ? `Focused ${windows[0].id}` : undefined,
        error: windows.length ? undefined : "No window in this session.",
        desktopHealthy: true,
        surface,
        sessionId: windows[0]?.id,
      };
    }
    return this.input(req, surface);
  }

  private sessionId(req: ComputerUseRequest, surface: ComputerSurface): string | undefined {
    if (req.sessionId) return req.sessionId;
    if (surface === "browser") return req.identity.browserSessionId ?? req.identity.projectRoot;
    return this.desktop.getSession(req.identity)?.id ?? this.desktop.sandbox(req.identity)?.id;
  }

  private async screenshot(req: ComputerUseRequest, surface: ComputerSurface): Promise<ComputerUseResult> {
    if (surface === "browser") {
      try {
        await this.browser.ensureSession(req.identity.projectRoot);
      } catch (err) {
        return {
          ok: false,
          error: String((err as Error).message ?? err),
          desktopHealthy: true,
          surface,
        };
      }
      const frame = await this.browser.captureScreenshot(req.identity.projectRoot);
      if (!frame) {
        return { ok: false, error: "No Browser frame. Open a page first.", desktopHealthy: true, surface };
      }
      return {
        ok: true,
        output: `Browser frame ${frame.bytes.length} bytes at ${frame.url}`,
        desktopHealthy: true,
        surface: "browser",
        sessionId: frame.sessionId,
        screenshot: { b64: frame.bytes.toString("base64"), mediaType: frame.mediaType },
      };
    }
    const shot = await this.desktop.captureScreenshot(req.identity);
    if (!shot || shot.bytes.length === 0) {
      const frame = await this.browser.captureScreenshot(req.identity.projectRoot);
      if (frame) {
        return {
          ok: true,
          output: `Desktop/browser frame ${frame.bytes.length} bytes at ${frame.url}`,
          desktopHealthy: true,
          surface: "browser",
          sessionId: frame.sessionId,
          screenshot: { b64: frame.bytes.toString("base64"), mediaType: frame.mediaType },
        };
      }
      return { ok: false, error: "No Desktop frame available.", desktopHealthy: true, surface: "desktop" };
    }
    return {
      ok: true,
      output: `Desktop frame ${shot.bytes.length} bytes`,
      desktopHealthy: true,
      surface: "desktop",
      sessionId: shot.sessionId,
      screenshot: { b64: shot.bytes.toString("base64"), mediaType: shot.mediaType },
    };
  }

  private async input(req: ComputerUseRequest, surface: ComputerSurface): Promise<ComputerUseResult> {
    if (surface === "browser") {
      const sent = await this.browser.sendInput(req.identity.projectRoot, req.action as "click" | "type" | "scroll" | "key" | "move", {
        x: req.x,
        y: req.y,
        button: req.button,
        text: req.text,
        key: req.key,
        deltaY: req.deltaY,
      });
      return {
        ok: sent.ok,
        output: sent.ok ? `Browser ${req.action}` : undefined,
        error: sent.error,
        desktopHealthy: true,
        surface: "browser",
        sessionId: sent.sessionId,
      };
    }
    if (surface === "host") {
      const sent = await this.desktop.sendHostInput(req.identity.tenantId, req.action as "click" | "type" | "scroll" | "key" | "move", {
        x: req.x,
        y: req.y,
        text: req.text,
        key: req.key,
        deltaY: req.deltaY,
      });
      return {
        ok: sent.ok,
        output: sent.ok ? sent.output ?? `Host ${req.action}` : undefined,
        error: sent.error,
        desktopHealthy: true,
        surface: "host",
      };
    }
    const sent = await this.desktop.sendInput(req.identity, req.action as "click" | "type" | "scroll" | "key" | "move", {
      x: req.x,
      y: req.y,
      button: req.button,
      text: req.text,
      key: req.key,
      deltaY: req.deltaY,
    });
    return {
      ok: sent.ok,
      output: sent.ok ? `Desktop ${req.action}` : undefined,
      error: sent.error,
      desktopHealthy: true,
      surface: "desktop",
      sessionId: sent.sessionId,
    };
  }
}

export const computerUseCapability = new ComputerUseCapability();
