// Workbench browser: one WebContentsView per tab, sandboxed guest session.
// Renderer talks only through validated IPC. Guests never get window.orvyn.

import { BrowserWindow, WebContentsView, app, session, shell } from "electron";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { promises as fs } from "fs";
import * as path from "path";
import {
  clampBrowserBounds,
  fitViewport,
  guestSecurityPrefs,
  isLocalBrowserUrl,
  isSafeBrowserUrl,
  normalizeBrowserInput,
  publicBrowserTab,
  rememberBrowserRecent,
  requestBrowserControl,
  type BrowserBounds,
  type BrowserKind,
  type BrowserOwner,
  type BrowserRecent,
  type BrowserTab,
  type BrowserViewport,
} from "./browserModel";

type TabEvent =
  | { kind: "console"; entry: { level: "error" | "warning"; message: string; source?: string; line?: number; at: number } }
  | { kind: "network"; entry: { method: string; url: string; status: number; error?: string; at: number } }
  | { kind: "navigated"; url: string }
  | { kind: "closed" };

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const PARTITION = "persist:orvyn-browser";
const MAX_TABS = 12;

export interface BrowserPublic {
  tabs: ReturnType<typeof publicBrowserTab>[];
  recents: BrowserRecent[];
  activeId: string | null;
}

type Guest = {
  tab: BrowserTab;
  view: WebContentsView;
  /** Whether the view is currently shown in the window. */
  shown?: boolean;
};

export class WorkbenchBrowserManager {
  private disposing = false;
  private readonly guests = new Map<string, Guest>();
  private activeId: string | null = null;
  private recents: BrowserRecent[] = [];
  private visible = false;
  private lastBounds: BrowserBounds | null = null;
  private loopback: Server | null = null;
  private loopbackPort = 0;
  private readonly token = `brk_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  private projectName: string | null = null;
  private boundWindow: BrowserWindow | null = null;
  private readonly tabListeners: Array<(tabId: string, event: TabEvent) => void> = [];
  /** Handles /v1/browser/session commands (BrowserSessionManager). */
  commandHandler: ((command: unknown) => Promise<unknown>) | null = null;

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  async start(): Promise<void> {
    this.recents = await loadRecents();
    const ses = session.fromPartition(PARTITION);
    ses.on("will-download", (_e, item) => {
      const guest = this.activeId ? this.guests.get(this.activeId) : undefined;
      const filename = item.getFilename();
      item.setSavePath(path.join(app.getPath("downloads"), filename));
      item.on("updated", () => {
        if (guest) {
          guest.tab.download = {
            filename,
            received: item.getReceivedBytes(),
            total: item.getTotalBytes(),
            state: item.getState(),
          };
          this.emit();
        }
      });
      item.once("done", () => {
        if (guest) {
          guest.tab.download = { filename, received: item.getTotalBytes(), total: item.getTotalBytes(), state: "completed" };
          this.emit();
        }
      });
    });
    // One listener for the whole partition (Electron keeps only the last one
    // registered). Failures are attributed to the tab that made the request.
    ses.webRequest.onCompleted({ urls: ["http://*/*", "https://*/*"] }, (details) => {
      if (details.statusCode < 400) return;
      this.networkError(details.webContentsId, { method: details.method, url: details.url.split("?")[0]!, status: details.statusCode });
    });
    ses.webRequest.onErrorOccurred({ urls: ["http://*/*", "https://*/*"] }, (details) => {
      if (details.error === "net::ERR_ABORTED") return;
      this.networkError(details.webContentsId, { method: details.method, url: details.url.split("?")[0]!, status: 0, error: details.error });
    });
    this.loopback = createServer((req, res) => void this.handleLoopback(req, res));
    await new Promise<void>((resolve) => this.loopback!.listen(0, "127.0.0.1", () => resolve()));
    const addr = this.loopback.address();
    this.loopbackPort = addr && typeof addr === "object" ? addr.port : 0;
  }

  loopbackInfo(): { url: string; token: string } | null {
    if (!this.loopbackPort) return null;
    return { url: `http://127.0.0.1:${this.loopbackPort}`, token: this.token };
  }

  setProjectName(name: string | null): void {
    this.projectName = name;
  }

  bindWindow(win: BrowserWindow | null): void {
    this.boundWindow = win;
    if (!win) return;
    const reapply = () => {
      if (this.visible && this.lastBounds) this.setBounds(this.lastBounds);
    };
    win.on("resize", reapply);
    win.on("maximize", reapply);
    win.on("unmaximize", reapply);
    win.on("restore", reapply);
    win.on("enter-full-screen", reapply);
    win.on("leave-full-screen", reapply);
    win.on("show", reapply);
  }

  async openUrl(kind: BrowserKind, url?: string): Promise<BrowserPublic> {
    if (url) {
      const parsed = normalizeBrowserInput(url);
      const href = parsed.ok ? parsed.url : url;
      const existing = [...this.guests.values()].find((g) => g.tab.url.replace(/\/$/, "") === href.replace(/\/$/, ""));
      if (existing) {
        existing.tab.kind = kind;
        return this.activate(existing.tab.id);
      }
    }
    return this.createTab(kind, url);
  }

  snapshot(): BrowserPublic {
    return {
      tabs: [...this.guests.values()].map((g) => publicBrowserTab(g.tab)),
      recents: this.recents,
      activeId: this.activeId,
    };
  }

  async createTab(kind: BrowserKind = "browser", url?: string): Promise<BrowserPublic> {
    if (this.guests.size >= MAX_TABS) {
      const oldest = [...this.guests.values()].sort((a, b) => a.tab.lastActiveAt - b.tab.lastActiveAt)[0];
      if (oldest) this.closeTab(oldest.tab.id);
    }
    const id = `b${Math.random().toString(36).slice(2, 10)}`;
    const now = Date.now();
    const tab: BrowserTab = {
      id,
      kind,
      url: "",
      title: kind === "preview" ? "Preview" : "Browser",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      secure: false,
      createdAt: now,
      lastActiveAt: now,
      controlOwner: "user",
      console: [],
      network: [],
    };
    const view = new WebContentsView({
      webPreferences: {
        ...guestSecurityPrefs(),
        session: session.fromPartition(PARTITION),
        // ORION keeps using a tab the user is not looking at: do not freeze it.
        backgroundThrottling: false,
      },
    });
    view.setVisible(false);
    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url: next }) => {
      if (isSafeBrowserUrl(next)) void this.createTab("browser", next);
      return { action: "deny" };
    });
    wc.on("will-navigate", (event, next) => {
      if (!isSafeBrowserUrl(next)) event.preventDefault();
    });
    wc.on("page-title-updated", (_e, title) => {
      tab.title = title || tab.url || tab.title;
      this.emit();
    });
    wc.on("page-favicon-updated", (_e, favs) => {
      const icon = favs.find((u) => /^https?:\/\//i.test(u));
      if (icon) tab.favicon = icon;
      this.emit();
    });
    wc.on("did-start-loading", () => {
      tab.loading = true;
      tab.error = undefined;
      this.emit();
    });
    wc.on("did-stop-loading", () => {
      tab.loading = false;
      this.syncNav(tab, wc);
      this.emit();
    });
    wc.on("did-navigate", (_e, next) => {
      this.tabEvent(id, { kind: "navigated", url: String(next) });
      this.applyUrl(tab, next);
      this.syncNav(tab, wc);
      this.emit();
    });
    wc.on("did-navigate-in-page", (_e, next) => {
      this.applyUrl(tab, next);
      this.syncNav(tab, wc);
      this.emit();
    });
    wc.on("did-fail-load", (_e, code, description, validatedURL, isMain) => {
      if (!isMain || code === -3) return;
      tab.loading = false;
      tab.error = { code: String(code), description: String(description || "Unable to load page") };
      if (validatedURL) tab.url = validatedURL;
      this.tabEvent(id, { kind: "network", entry: { method: "GET", url: String(validatedURL || tab.url).split("?")[0]!, status: 0, error: `${code} ${description}`, at: Date.now() } });
      this.emit();
    });
    wc.on("certificate-error", (event, nextUrl, error, _cert, callback) => {
      if (isLocalBrowserUrl(nextUrl)) {
        callback(true);
        return;
      }
      event.preventDefault();
      tab.error = { code: "ERR_CERT", description: `This site's certificate is not trusted. (${String(error)})` };
      callback(false);
      this.emit();
    });
    wc.on("console-message", (_e, level, message, line, sourceId) => {
      if (level < 2) return;
      // Electron's own dev-mode warning, not the page's.
      if (/Electron Security Warning/.test(String(message))) return;
      const text = String(message).slice(0, 240);
      tab.console.push(text);
      if (tab.console.length > 40) tab.console.shift();
      this.tabEvent(id, { kind: "console", entry: { level: level >= 3 ? "error" : "warning", message: text, source: String(sourceId || "").slice(0, 200) || undefined, line: Number(line) || undefined, at: Date.now() } });
    });
    wc.on("before-input-event", (event) => {
      if (tab.controlOwner === "orion") event.preventDefault();
    });
    this.guests.set(id, { tab, view });
    this.activeId = id;
    if (url) await this.navigate(id, url);
    this.emit();
    return this.snapshot();
  }

  async navigate(id: string, raw: string): Promise<BrowserPublic> {
    const guest = this.require(id);
    const parsed = normalizeBrowserInput(raw);
    if (!parsed.ok) {
      guest.tab.error = { code: "ERR_INVALID_URL", description: parsed.reason === "blocked-scheme" ? "That address is not allowed." : "Enter a URL or domain." };
      this.emit();
      return this.snapshot();
    }
    guest.tab.error = undefined;
    guest.tab.loading = true;
    guest.tab.url = parsed.url;
    guest.tab.title = parsed.url.replace(/^https?:\/\//, "");
    guest.tab.lastActiveAt = Date.now();
    this.activeId = id;
    await guest.view.webContents.loadURL(parsed.url).catch(() => {
      /* did-fail-load updates the tab */
    });
    this.applyUrl(guest.tab, guest.view.webContents.getURL() || parsed.url);
    this.syncNav(guest.tab, guest.view.webContents);
    this.remember(guest.tab);
    this.emit();
    return this.snapshot();
  }

  back(id: string): BrowserPublic {
    const guest = this.require(id);
    if (guest.view.webContents.canGoBack()) guest.view.webContents.goBack();
    return this.snapshot();
  }

  forward(id: string): BrowserPublic {
    const guest = this.require(id);
    if (guest.view.webContents.canGoForward()) guest.view.webContents.goForward();
    return this.snapshot();
  }

  reload(id: string): BrowserPublic {
    const guest = this.require(id);
    if (guest.tab.loading) guest.view.webContents.stop();
    else guest.view.webContents.reload();
    return this.snapshot();
  }

  activate(id: string | null): BrowserPublic {
    this.activeId = id && this.guests.has(id) ? id : null;
    if (this.activeId) this.guests.get(this.activeId)!.tab.lastActiveAt = Date.now();
    this.attachActive();
    this.emit();
    return this.snapshot();
  }

  closeTab(id: string): BrowserPublic {
    const guest = this.guests.get(id);
    if (!guest) return this.snapshot();
    this.detach(guest);
    try { if (!guest.view.webContents.isDestroyed()) guest.view.webContents.close(); } catch { /* already gone */ }
    this.guests.delete(id);
    this.tabEvent(id, { kind: "closed" });
    if (this.activeId === id) this.activeId = [...this.guests.keys()].at(-1) ?? null;
    if (this.disposing) return this.snapshot();
    this.attachActive();
    this.emit();
    return this.snapshot();
  }

  setBounds(bounds: BrowserBounds): BrowserPublic {
    const next = clampBrowserBounds(bounds);
    if (next) this.lastBounds = next;
    if (this.visible) this.attachActive();
    return this.snapshot();
  }

  setSurfaceVisible(visible: boolean): BrowserPublic {
    this.visible = visible;
    this.attachActive();
    return this.snapshot();
  }

  takeControl(id: string): BrowserPublic {
    const guest = this.require(id);
    requestBrowserControl(guest.tab, "user");
    void this.injectCursor(guest, null);
    this.emit();
    return this.snapshot();
  }

  returnControl(id: string): BrowserPublic {
    const guest = this.require(id);
    requestBrowserControl(guest.tab, "orion");
    this.emit();
    return this.snapshot();
  }

  async click(id: string, input: { selector?: string; x?: number; y?: number }): Promise<{ ok: boolean; x?: number; y?: number; error?: string }> {
    const guest = this.require(id);
    if (guest.tab.controlOwner !== "orion") return { ok: false, error: "ORION does not control this tab." };
    const result = await guest.view.webContents.executeJavaScript(
      `(${clickScript})(${JSON.stringify(input.selector ?? "")}, ${Number(input.x ?? 0)}, ${Number(input.y ?? 0)})`,
      true
    );
    await this.injectCursor(guest, { x: result.x, y: result.y, kind: "click" });
    return { ok: true, x: result.x, y: result.y };
  }

  async inspect(id: string): Promise<{ ok: boolean; url?: string; title?: string; outline?: string; error?: string }> {
    const guest = this.guests.get(id) ?? (this.activeId ? this.guests.get(this.activeId) : undefined);
    if (!guest) return { ok: false, error: "No browser tab." };
    const outline = await guest.view.webContents.executeJavaScript(`(${inspectScript})()`, true).catch(() => "");
    return { ok: true, url: guest.tab.url, title: guest.tab.title, outline: String(outline || "") };
  }

  async type(id: string, input: { selector?: string; text: string }): Promise<{ ok: boolean; error?: string }> {
    const guest = this.require(id);
    if (guest.tab.controlOwner !== "orion") return { ok: false, error: "ORION does not control this tab." };
    await guest.view.webContents.executeJavaScript(
      `(${typeScript})(${JSON.stringify(input.selector ?? "")}, ${JSON.stringify(input.text)})`,
      true
    );
    return { ok: true };
  }

  async scroll(id: string, deltaY: number): Promise<{ ok: boolean }> {
    const guest = this.require(id);
    if (guest.tab.controlOwner !== "orion") return { ok: false };
    await guest.view.webContents.executeJavaScript(`window.scrollBy(0, ${Number(deltaY) || 400})`, true);
    return { ok: true };
  }

  async screenshot(id: string): Promise<{ ok: boolean; png?: string; url?: string; error?: string }> {
    const guest = this.guests.get(id) ?? (this.activeId ? this.guests.get(this.activeId) : undefined);
    if (!guest) return { ok: false, error: "No browser tab." };
    const image = await guest.view.webContents.capturePage();
    return { ok: true, png: image.toPNG().toString("base64"), url: guest.tab.url };
  }

  async openExternal(id: string): Promise<boolean> {
    const guest = this.guests.get(id);
    if (!guest || !isSafeBrowserUrl(guest.tab.url)) return false;
    await shell.openExternal(guest.tab.url);
    return true;
  }

  async clearData(): Promise<BrowserPublic> {
    await session.fromPartition(PARTITION).clearStorageData();
    this.recents = [];
    await saveRecents([]);
    this.emit();
    return this.snapshot();
  }

  openDevTools(id: string): void {
    if (app.isPackaged && !process.env.ORVYN_DEV) return;
    this.guests.get(id)?.view.webContents.openDevTools({ mode: "detach" });
  }

  dispose(): void {
    // The app is quitting: the window may already be destroyed. Close the tabs
    // without touching it (that threw "Object has been destroyed").
    this.disposing = true;
    for (const id of [...this.guests.keys()]) this.closeTab(id);
    this.loopback?.close();
    this.loopback = null;
  }

  // ── Session support (BrowserSessionManager) ─────────────────────────────

  onTabEvent(fn: (tabId: string, event: TabEvent) => void): void {
    this.tabListeners.push(fn);
  }

  hasTab(tabId: string): boolean {
    return this.guests.has(tabId);
  }

  tabInfo(tabId: string): { url: string; title: string } | undefined {
    const g = this.guests.get(tabId);
    return g ? { url: g.tab.url, title: g.tab.title } : undefined;
  }

  /** A new tab owned by an ORION session: ORION controls it, the user watches it. */
  async createSessionTab(sessionId: string, url?: string): Promise<string> {
    await this.createTab("browser");
    const id = this.activeId!;
    const guest = this.guests.get(id)!;
    guest.tab.sessionId = sessionId;
    requestBrowserControl(guest.tab, "orion");
    if (url) await this.navigate(id, url);
    this.emit();
    return id;
  }

  /** Brings a tab to the front and asks the window to show the Browser. */
  reveal(tabId: string): void {
    if (!this.guests.has(tabId)) return;
    this.activeId = tabId;
    this.guests.get(tabId)!.tab.lastActiveAt = Date.now();
    this.attachActive();
    this.emit();
    const tab = publicBrowserTab(this.guests.get(tabId)!.tab);
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("browser:reveal", { tabId, sessionId: tab.sessionId, tab });
  }

  /**
   * Resizes the page ORION and the user share. The visible view takes the
   * viewport's width (centered in the surface) and CDP emulates the device
   * metrics, so layout, screenshots and what the user sees all agree.
   */
  async setTabViewport(tabId: string, viewport: BrowserViewport): Promise<{ width: number; height: number; innerWidth?: number; innerHeight?: number; mobile: boolean }> {
    const guest = this.guests.get(tabId);
    if (!guest) throw new Error("Unknown browser tab.");
    guest.tab.viewport = viewport.preset === "desktop" ? undefined : viewport;
    this.attachActive();
    const box = this.lastBounds ? fitViewport(this.lastBounds, guest.tab.viewport) : { width: viewport.width, height: viewport.height };
    const wc = guest.view.webContents;
    const dbg = wc.debugger;
    try {
      if (!dbg.isAttached()) dbg.attach("1.3");
      if (viewport.preset === "desktop") {
        await dbg.sendCommand("Emulation.clearDeviceMetricsOverride");
        await dbg.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: false });
        await dbg.sendCommand("Emulation.setUserAgentOverride", { userAgent: wc.session.getUserAgent() });
      } else {
        await dbg.sendCommand("Emulation.setDeviceMetricsOverride", { width: box.width, height: box.height, deviceScaleFactor: 0, mobile: viewport.mobile });
        await dbg.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: viewport.mobile, maxTouchPoints: viewport.mobile ? 5 : 1 });
        if (viewport.mobile) await dbg.sendCommand("Emulation.setUserAgentOverride", { userAgent: MOBILE_UA, platform: "iPhone" });
      }
    } catch {
      /* the view size alone still sets the layout width */
    }
    this.emit();
    await new Promise((r) => setTimeout(r, 150));
    const inner = await wc.executeJavaScript("({ w: window.innerWidth, h: window.innerHeight })", true).catch(() => null) as { w: number; h: number } | null;
    return { width: box.width, height: box.height, innerWidth: inner?.w, innerHeight: inner?.h, mobile: viewport.mobile };
  }

  async capture(tabId: string): Promise<{ png: Buffer; width: number; height: number } | null> {
    const guest = this.guests.get(tabId);
    if (!guest) return null;
    const wc = guest.view.webContents;
    const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
    // A tab the user is not looking at (the Files tab is open, or the panel is
    // closed) is detached from the window and paints nothing, so it could not
    // be captured ("The Workbench tab could not be captured."). Paint it
    // backstage for the capture: attached UNDER the app page (the user never
    // sees it) at the surface size, with the capturer keeping it rendering.
    if (wc.isDestroyed()) return null;
    const backstage = !guest.shown;
    const win = this.boundWindow ?? this.getWindow();
    if (backstage && win && !win.isDestroyed()) {
      try {
        try { win.contentView.removeChildView(guest.view); } catch { /* not attached */ }
        win.contentView.addChildView(guest.view, 0);
        guest.view.setBounds(fitViewport(this.lastBounds ?? { x: 0, y: 0, width: 1280, height: 800 }, guest.tab.viewport));
        guest.view.setVisible(true);
        wc.invalidate();
        await new Promise((r) => setTimeout(r, 250));
      } catch { /* capture below still tries */ }
    }
    try {
      const image = await within(wc.capturePage(undefined, { stayHidden: true, stayAwake: true }), 8000).catch(() => null);
      if (image && !image.isEmpty()) {
        const size = image.getSize();
        return { png: image.toPNG(), width: size.width, height: size.height };
      }
      try {
        if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
        const shot = await within(wc.debugger.sendCommand("Page.captureScreenshot", { format: "png" }) as Promise<{ data: string }>, 8000);
        if (!shot?.data) return null;
        const png = Buffer.from(shot.data, "base64");
        return { png, width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
      } catch {
        return null;
      }
    } finally {
      // Back to what the user was looking at.
      if (backstage) this.attachActive();
    }
  }

  /** Where each guest view is right now (for acceptance checks and diagnostics). */
  surfaceReport(): { activeId: string | null; visible: boolean; surface: BrowserBounds | null; views: { tabId: string; sessionId?: string; attached: boolean; visible: boolean; bounds: BrowserBounds; url: string }[] } {
    const win = this.boundWindow ?? this.getWindow();
    const kids = win?.contentView.children ?? [];
    return {
      activeId: this.activeId,
      visible: this.visible,
      surface: this.lastBounds,
      views: [...this.guests.values()].map((g) => ({
        tabId: g.tab.id,
        sessionId: g.tab.sessionId,
        attached: kids.includes(g.view),
        visible: Boolean(g.shown),
        bounds: g.view.getBounds(),
        url: g.tab.url,
      })),
    };
  }

  private tabEvent(tabId: string, event: TabEvent): void {
    for (const fn of this.tabListeners) {
      try { fn(tabId, event); } catch { /* a listener never breaks the browser */ }
    }
  }

  private networkError(webContentsId: number | undefined, entry: { method: string; url: string; status: number; error?: string }): void {
    const guest = [...this.guests.values()].find((g) => g.view.webContents.id === webContentsId);
    if (!guest) return;
    guest.tab.network.push({ method: entry.method, url: entry.url, status: entry.status });
    if (guest.tab.network.length > 40) guest.tab.network.shift();
    this.tabEvent(guest.tab.id, { kind: "network", entry: { ...entry, at: Date.now() } });
  }

  private require(id: string): Guest {
    const guest = this.guests.get(id) || (this.activeId ? this.guests.get(this.activeId) : undefined);
    if (!guest) throw new Error("Unknown browser tab.");
    return guest;
  }

  private applyUrl(tab: BrowserTab, url: string): void {
    if (!isSafeBrowserUrl(url)) return;
    tab.url = url;
    tab.secure = url.startsWith("https:");
    if (tab.kind === "preview" && this.projectName) {
      try {
        const port = new URL(url).port;
        tab.title = `${this.projectName.slice(0, 18)}${port ? ` :${port}` : ""}`.trim();
      } catch {
        /* keep title */
      }
    }
    this.remember(tab);
  }

  private syncNav(tab: BrowserTab, wc: Electron.WebContents): void {
    tab.canGoBack = wc.canGoBack();
    tab.canGoForward = wc.canGoForward();
    tab.loading = wc.isLoading();
  }

  private remember(tab: BrowserTab): void {
    if (!tab.url) return;
    this.recents = rememberBrowserRecent(this.recents, {
      url: tab.url,
      title: tab.title || tab.url,
      favicon: tab.favicon,
      lastVisitedAt: Date.now(),
    });
    void saveRecents(this.recents);
  }

  private attachActive(): void {
    const win = this.boundWindow ?? this.getWindow();
    if (!win || win.isDestroyed() || this.disposing) return;
    for (const guest of this.guests.values()) {
      if (guest.view.webContents.isDestroyed()) continue;
      const show = this.visible && guest.tab.id === this.activeId && !!guest.tab.url && !guest.tab.error;
      if (show && this.lastBounds) {
        // Index 0 sits under the window page, so the site never appears and a
        // full-size view covers the Workbench menus. Keep the guest on top,
        // clipped to the surface rectangle measured by the renderer.
        const kids = win.contentView.children;
        if (!kids.includes(guest.view) || kids[kids.length - 1] !== guest.view) {
          try { win.contentView.removeChildView(guest.view); } catch { /* not attached */ }
          win.contentView.addChildView(guest.view);
        }
        // An emulated viewport (mobile, tablet) is centered at its own width:
        // the user sees exactly the page size ORION is testing.
        guest.view.setBounds(fitViewport(this.lastBounds, guest.tab.viewport));
        guest.view.setVisible(true);
        guest.shown = true;
      } else {
        this.detach(guest);
      }
    }
  }

  private detach(guest: Guest): void {
    const win = this.getWindow();
    guest.shown = false;
    try {
      guest.view.setVisible(false);
      if (win && !win.isDestroyed()) win.contentView.removeChildView(guest.view);
    } catch {
      /* already detached, or the window is gone */
    }
  }

  private emit(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send("browser:changed", this.snapshot());
    }
  }

  private async injectCursor(guest: Guest, cursor: { x: number; y: number; kind: string } | null): Promise<void> {
    await guest.view.webContents.executeJavaScript(`(${cursorScript})(${JSON.stringify(cursor)})`, true).catch(() => {});
  }

  private async handleLoopback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.socket.remoteAddress && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    if (req.headers["x-orvyn-browser-token"] !== this.token) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    const body = await readBody(req);
    const id = String(body.tabId ?? this.activeId ?? "");
    try {
      if (req.url === "/v1/browser/session" && req.method === "POST") {
        if (!this.commandHandler) return json(res, { ok: false, error: "Browser sessions are not ready." }, 503);
        json(res, await this.commandHandler(body));
        return;
      }
      if (req.url === "/v1/browser/open" && req.method === "POST") {
        const snap = await this.openUrl("browser", String(body.url ?? ""));
        const tab = snap.tabs.find((t) => t.id === snap.activeId);
        if (tab) requestBrowserControl(this.require(tab.id).tab, "orion");
        json(res, { ok: true, tab });
        return;
      }
      if (req.url === "/v1/browser/inspect" && req.method === "POST") {
        json(res, await this.inspect(id));
        return;
      }
      if (req.url === "/v1/browser/navigate" && req.method === "POST") {
        json(res, { ok: true, ...(await this.navigate(id, String(body.url ?? ""))) });
        return;
      }
      if (req.url === "/v1/browser/click" && req.method === "POST") {
        json(res, await this.click(id, body));
        return;
      }
      if (req.url === "/v1/browser/type" && req.method === "POST") {
        json(res, await this.type(id, { selector: String(body.selector ?? ""), text: String(body.text ?? "") }));
        return;
      }
      if (req.url === "/v1/browser/scroll" && req.method === "POST") {
        json(res, await this.scroll(id, Number(body.deltaY ?? 400)));
        return;
      }
      if (req.url === "/v1/browser/screenshot" && req.method === "POST") {
        json(res, await this.screenshot(id));
        return;
      }
      if (req.url === "/v1/browser/state" && req.method === "GET") {
        json(res, this.snapshot());
        return;
      }
      res.writeHead(404).end("not found");
    } catch (err: any) {
      json(res, { ok: false, error: err.message }, 500);
    }
  }
}

function recentsFile(): string {
  return path.join(app.getPath("userData"), "orvyn-browser-recents.json");
}

async function loadRecents(): Promise<BrowserRecent[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(recentsFile(), "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r) => r && typeof r.url === "string" && isSafeBrowserUrl(r.url))
      .map((r) => ({
        url: r.url,
        title: String(r.title ?? r.url),
        favicon: typeof r.favicon === "string" && isSafeBrowserUrl(r.favicon) ? r.favicon : undefined,
        lastVisitedAt: Number(r.lastVisitedAt) || Date.now(),
      }))
      .slice(0, 16);
  } catch {
    return [];
  }
}

async function saveRecents(recents: BrowserRecent[]): Promise<void> {
  await fs.writeFile(recentsFile(), JSON.stringify(recents), "utf-8");
}

async function readBody(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    return {};
  }
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const clickScript = `function (selector, x, y) {
  const el = selector ? document.querySelector(selector) : document.elementFromPoint(x, y);
  if (!el) throw new Error("No click target.");
  el.click();
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}`;

const typeScript = `function (selector, text) {
  const el = selector ? document.querySelector(selector) : document.activeElement;
  if (!el) throw new Error("No type target.");
  el.focus();
  if ("value" in el) el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  const prev = el.style.outline;
  el.style.outline = "2px solid rgba(34,211,238,.7)";
  setTimeout(function () { el.style.outline = prev; }, 420);
}`;

const inspectScript = `function () {
  return [...document.querySelectorAll("a,button,input,textarea,select,h1,h2,h3,[role]")].slice(0, 40).map(function (el) {
    const role = el.getAttribute("role") || el.tagName.toLowerCase();
    const name = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0, 60);
    return role + (name ? " \\"" + name + "\\"" : "");
  }).join("\\n");
}`;

const cursorScript = `function (cursor) {
  var node = document.getElementById("orvyn-orion-cursor");
  if (!cursor) { if (node) node.remove(); return; }
  if (!node) {
    node = document.createElement("div");
    node.id = "orvyn-orion-cursor";
    node.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;width:18px;height:18px;transition:left .26s ease,top .26s ease;filter:drop-shadow(0 0 4px #22d3ee)";
    node.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18"><path d="M2 1.6 15.4 8.1l-6.1 1.5L7.4 16.2Z" fill="#22D3EE" stroke="#0b1220" stroke-width="1"/></svg><span style="position:absolute;left:16px;top:-2px;font:700 9px/1 sans-serif;background:#22D3EE;color:#0b1220;border-radius:4px;padding:1px 4px">ORION</span>';
    document.documentElement.appendChild(node);
  }
  node.style.left = cursor.x + "px";
  node.style.top = cursor.y + "px";
  if (cursor.kind === "click") {
    var pulse = document.createElement("div");
    pulse.style.cssText = "position:fixed;left:" + (cursor.x - 10) + "px;top:" + (cursor.y - 10) + "px;width:20px;height:20px;border-radius:99px;border:2px solid #22d3ee;pointer-events:none;z-index:2147483646;animation:orvyn-pulse .32s ease-out forwards";
    if (!document.getElementById("orvyn-orion-pulse-style")) {
      var style = document.createElement("style");
      style.id = "orvyn-orion-pulse-style";
      style.textContent = "@keyframes orvyn-pulse{to{transform:scale(2.2);opacity:0}}";
      document.documentElement.appendChild(style);
    }
    document.documentElement.appendChild(pulse);
    setTimeout(function () { pulse.remove(); }, 360);
  }
}`;

export function createWorkbenchBrowserManager(getWindow: () => BrowserWindow | null): WorkbenchBrowserManager {
  return new WorkbenchBrowserManager(getWindow);
}

export async function registerBrowserIpc(manager: WorkbenchBrowserManager): Promise<void> {
  const { ipcMain } = await import("electron");
  ipcMain.handle("browser:list", () => manager.snapshot());
  ipcMain.handle("browser:create", (_e, kind?: BrowserKind, url?: string) => manager.openUrl(kind === "preview" ? "preview" : "browser", url));
  ipcMain.handle("browser:inspect", (_e, id: string) => manager.inspect(String(id)));
  ipcMain.handle("browser:navigate", (_e, id: string, url: string) => manager.navigate(String(id), String(url)));
  ipcMain.handle("browser:back", (_e, id: string) => manager.back(String(id)));
  ipcMain.handle("browser:forward", (_e, id: string) => manager.forward(String(id)));
  ipcMain.handle("browser:reload", (_e, id: string) => manager.reload(String(id)));
  ipcMain.handle("browser:activate", (_e, id: string | null) => manager.activate(id ? String(id) : null));
  ipcMain.handle("browser:close", (_e, id: string) => manager.closeTab(String(id)));
  ipcMain.handle("browser:setBounds", (_e, bounds: BrowserBounds) => manager.setBounds(bounds ?? { x: 0, y: 0, width: 0, height: 0 }));
  ipcMain.handle("browser:setVisible", (_e, visible: boolean) => manager.setSurfaceVisible(visible === true));
  ipcMain.handle("browser:takeControl", (_e, id: string) => manager.takeControl(String(id)));
  ipcMain.handle("browser:returnControl", (_e, id: string) => manager.returnControl(String(id)));
  ipcMain.handle("browser:openExternal", (_e, id: string) => manager.openExternal(String(id)));
  ipcMain.handle("browser:clearData", () => manager.clearData());
  ipcMain.handle("browser:openDevTools", (_e, id: string) => {
    manager.openDevTools(String(id));
    return true;
  });
}
