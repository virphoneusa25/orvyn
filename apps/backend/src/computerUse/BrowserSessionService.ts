import {
  captureBrowserFrame,
  closeBrowserSession,
  ensureBrowserSession,
  getBrowserSession,
} from "../ai/tools/browserTools";

/**
 * Browser computer-use surface. Prefer this for pure web tasks; Desktop is
 * for native UI, multi-window, and system dialogs.
 */
export class BrowserSessionService {
  getSession(projectRoot: string) {
    return getBrowserSession(projectRoot);
  }

  async ensureSession(projectRoot: string) {
    return ensureBrowserSession(projectRoot);
  }

  async captureScreenshot(projectRoot: string): Promise<{ bytes: Buffer; mediaType: string; url: string; sessionId: string } | null> {
    const existing = getBrowserSession(projectRoot);
    if (!existing) return null;
    const frame = await captureBrowserFrame(projectRoot);
    if (!frame) return null;
    return { bytes: frame.jpeg, mediaType: "image/jpeg", url: frame.url, sessionId: projectRoot };
  }

  async sendInput(
    projectRoot: string,
    action: "click" | "type" | "scroll" | "key" | "move",
    args: { x?: number; y?: number; button?: "left" | "right" | "middle"; text?: string; key?: string; deltaY?: number }
  ): Promise<{ ok: boolean; error?: string; sessionId: string }> {
    try {
      const page = getBrowserSession(projectRoot)?.page ?? (await ensureBrowserSession(projectRoot)).page;
      if (action === "click") await page.mouse.click(Number(args.x ?? 0), Number(args.y ?? 0), { button: args.button ?? "left" });
      else if (action === "move") await page.mouse.move(Number(args.x ?? 0), Number(args.y ?? 0));
      else if (action === "type") await page.keyboard.type(String(args.text ?? ""), { delay: 12 });
      else if (action === "key") await page.keyboard.press(String(args.key ?? "Enter"));
      else if (action === "scroll") await page.mouse.wheel(0, Number(args.deltaY ?? 400));
      return { ok: true, sessionId: projectRoot };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err), sessionId: projectRoot };
    }
  }

  cleanup(projectRoot: string): void {
    closeBrowserSession(projectRoot);
  }
}

export const browserSessionService = new BrowserSessionService();
