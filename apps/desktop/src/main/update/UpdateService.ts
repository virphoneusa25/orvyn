import { feedUrlForChannel, latestManifestName, parseUpdateChannel, versionMatchesChannel, type UpdateChannel } from "./updateChannels";
import { inStagedRollout, requiredUpdateBlocksCloud } from "./updatePolicy";
import { loadUpdatePrefs, saveUpdatePrefs, type UpdatePrefs } from "./updatePrefs";
import { UPDATE_IPC, parseBooleanArg, parseRestartArg } from "./updateIpc";
import {
  initialUpdateState,
  isTransientUpdateFailure,
  publicUpdateState,
  reduceUpdate,
  type DesktopUpdateState,
} from "./updateState";

export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  disableWebInstaller?: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  setFeedURL(opts: { provider: "generic"; url: string }): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface ControlPlanePolicy {
  latest?: string;
  minimumSupported?: string;
  required?: boolean;
  notes?: string;
  publishedAt?: string;
  rolloutPercent?: number;
  paused?: boolean;
}

export interface UpdateServiceOptions {
  userData: string;
  packaged: boolean;
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  getBackend: () => Promise<{ backendUrl: string; apiKey: string }>;
  send: (channel: string, payload: unknown) => void;
  loadUpdater?: () => Promise<AutoUpdaterLike | null>;
  now?: () => number;
  fetchImpl?: typeof fetch;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}

const STARTUP_DELAY_MS = 12_000;
const CHECK_INTERVAL_MS = 5 * 60 * 60 * 1000;
const JITTER_MS = 20 * 60 * 1000;

export class UpdateService {
  private state: DesktopUpdateState;
  private prefs!: UpdatePrefs;
  private updater: AutoUpdaterLike | null = null;
  private workBusy = false;
  private dismissedVersion: string | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private started = false;
  private readonly opts: UpdateServiceOptions;

  constructor(opts: UpdateServiceOptions) {
    this.opts = opts;
    this.state = initialUpdateState({
      currentVersion: opts.currentVersion,
      channel: "stable",
      packaged: opts.packaged,
    });
  }

  getState(): DesktopUpdateState {
    return publicUpdateState(this.state);
  }

  isCloudRestricted(): boolean {
    return requiredUpdateBlocksCloud({
      currentVersion: this.state.currentVersion,
      minimumSupportedVersion: this.state.minimumSupportedVersion,
      required: this.state.required,
    });
  }

  setWorkBusy(busy: boolean): void {
    this.workBusy = busy === true;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.prefs = await loadUpdatePrefs(this.opts.userData);
    this.state = reduceUpdate(this.state, {
      type: "prefs",
      autoCheck: this.prefs.autoCheck,
      autoDownload: this.prefs.autoDownload,
      installOnExit: this.prefs.installOnExit,
      channel: this.prefs.channel,
    });
    this.emit();
    void this.report("app_started");
    this.schedule(() => {
      void this.check({ reason: "startup" });
    }, STARTUP_DELAY_MS + Math.floor(Math.random() * 15_000));
    this.scheduleLoop();
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private async ensurePrefs() {
    if (this.prefs) return;
    this.prefs = await loadUpdatePrefs(this.opts.userData);
    this.state = reduceUpdate(this.state, {
      type: "prefs",
      autoCheck: this.prefs.autoCheck,
      autoDownload: this.prefs.autoDownload,
      installOnExit: this.prefs.installOnExit,
      channel: this.prefs.channel,
    });
  }

  async check(opts?: { reason?: string }): Promise<DesktopUpdateState> {
    await this.ensurePrefs();
    this.state = reduceUpdate(this.state, { type: "checking" });
    this.emit();
    void this.report("update_check");
    try {
      await this.refreshPolicy();
    } catch {
      /* offline policy must not break the app */
    }
    if (!this.opts.packaged) {
      this.state = reduceUpdate(this.state, { type: "not_available" });
      this.emit();
      return this.getState();
    }
    try {
      const updater = await this.ensureUpdater();
      if (!updater) {
        this.state = reduceUpdate(this.state, { type: "not_available" });
        this.emit();
        return this.getState();
      }
      const reachable = await this.feedReachable();
      if (!reachable) {
        this.state = reduceUpdate(this.state, { type: "not_available" });
        this.emit();
        return this.getState();
      }
      await updater.checkForUpdates();
    } catch (err) {
      this.onError(err);
    }
    return this.getState();
  }

  async download(): Promise<DesktopUpdateState> {
    await this.ensurePrefs();
    if (!this.opts.packaged) return this.getState();
    void this.report("update_download_started");
    try {
      const updater = await this.ensureUpdater();
      if (!updater) throw new Error("offline");
      await updater.downloadUpdate();
    } catch (err) {
      this.onError(err);
    }
    return this.getState();
  }

  async restartAndInstall(raw?: unknown): Promise<{ ok: boolean; code?: string; message?: string }> {
    const { force } = parseRestartArg(raw);
    if (this.workBusy && !force) {
      return { ok: false, code: "mission_active", message: "Finish or stop the current mission before restarting." };
    }
    if (this.state.status !== "downloaded") {
      return { ok: false, code: "not_ready", message: "The update is not ready to install yet." };
    }
    void this.report("update_install_requested");
    try {
      const updater = await this.ensureUpdater();
      updater?.quitAndInstall(false, true);
      return { ok: true };
    } catch (err) {
      this.onError(err);
      return { ok: false, code: "install_failed", message: this.getState().error };
    }
  }

  async installOnExit(): Promise<DesktopUpdateState> {
    await this.ensurePrefs();
    this.state = reduceUpdate(this.state, { type: "install_on_exit", armed: true });
    if (this.updater) this.updater.autoInstallOnAppQuit = true;
    this.prefs = { ...this.prefs, installOnExit: true, installOnExitOptIn: true };
    await saveUpdatePrefs(this.opts.userData, this.prefs);
    this.emit();
    void this.report("update_install_requested");
    return this.getState();
  }

  async setChannel(raw: unknown): Promise<DesktopUpdateState> {
    await this.ensurePrefs();
    const channel = parseUpdateChannel(raw);
    if (!channel) {
      this.state = reduceUpdate(this.state, { type: "error", message: "Invalid update channel." });
      this.emit();
      return this.getState();
    }
    this.prefs = { ...this.prefs, channel };
    await saveUpdatePrefs(this.opts.userData, this.prefs);
    this.state = reduceUpdate(this.state, {
      type: "prefs",
      autoCheck: this.prefs.autoCheck,
      autoDownload: this.prefs.autoDownload,
      installOnExit: this.prefs.installOnExit,
      channel,
    });
    this.emit();
    if (this.updater) this.applyFeed(this.updater, channel);
    return this.check({ reason: "channel" });
  }

  async setAutoDownload(raw: unknown): Promise<DesktopUpdateState> {
    const v = parseBooleanArg(raw);
    if (v === null) return this.getState();
    this.prefs = { ...this.prefs, autoDownload: v };
    await saveUpdatePrefs(this.opts.userData, this.prefs);
    if (this.updater) this.updater.autoDownload = v;
    this.state = reduceUpdate(this.state, {
      type: "prefs",
      autoCheck: this.prefs.autoCheck,
      autoDownload: v,
      installOnExit: this.prefs.installOnExit,
      channel: this.prefs.channel,
    });
    this.emit();
    return this.getState();
  }

  async setAutoCheck(raw: unknown): Promise<DesktopUpdateState> {
    const v = parseBooleanArg(raw);
    if (v === null) return this.getState();
    this.prefs = { ...this.prefs, autoCheck: v };
    await saveUpdatePrefs(this.opts.userData, this.prefs);
    this.state = reduceUpdate(this.state, {
      type: "prefs",
      autoCheck: v,
      autoDownload: this.prefs.autoDownload,
      installOnExit: this.prefs.installOnExit,
      channel: this.prefs.channel,
    });
    this.emit();
    return this.getState();
  }

  async setInstallOnExitPref(raw: unknown): Promise<DesktopUpdateState> {
    const v = parseBooleanArg(raw);
    if (v === null) return this.getState();
    this.prefs = { ...this.prefs, installOnExit: v, installOnExitOptIn: v };
    await saveUpdatePrefs(this.opts.userData, this.prefs);
    if (this.updater) this.updater.autoInstallOnAppQuit = v;
    if (!v) this.state = reduceUpdate(this.state, { type: "install_on_exit", armed: false });
    this.state = reduceUpdate(this.state, {
      type: "prefs",
      autoCheck: this.prefs.autoCheck,
      autoDownload: this.prefs.autoDownload,
      installOnExit: v,
      channel: this.prefs.channel,
    });
    this.emit();
    return this.getState();
  }

  dismiss(): DesktopUpdateState {
    if (this.state.required) return this.getState();
    this.dismissedVersion = this.state.availableVersion ?? null;
    this.state = reduceUpdate(this.state, { type: "not_available" });
    this.emit();
    return this.getState();
  }

  handleWillQuit(): void {
    if (this.state.installOnExitArmed && this.updater && this.state.status === "downloaded") {
      try {
        this.updater.autoInstallOnAppQuit = true;
      } catch {
        /* ignore */
      }
    }
  }

  private scheduleLoop(): void {
    this.schedule(() => {
      if (this.prefs?.autoCheck) void this.check({ reason: "interval" });
      this.scheduleLoop();
    }, CHECK_INTERVAL_MS + Math.floor(Math.random() * JITTER_MS));
  }

  private schedule(fn: () => void, ms: number): void {
    this.timers.push(setTimeout(fn, ms));
  }

  private async ensureUpdater(): Promise<AutoUpdaterLike | null> {
    if (this.updater) return this.updater;
    const load = this.opts.loadUpdater ?? defaultLoadUpdater;
    const updater = await load();
    if (!updater) return null;
    updater.allowDowngrade = false;
    updater.autoDownload = this.prefs.autoDownload;
    updater.autoInstallOnAppQuit = this.prefs.installOnExit;
    updater.allowPrerelease = this.prefs.channel !== "stable";
    if (updater.disableWebInstaller !== undefined) updater.disableWebInstaller = true;
    this.applyFeed(updater, this.prefs.channel);
    this.bindUpdater(updater);
    this.updater = updater;
    return updater;
  }

  private applyFeed(updater: AutoUpdaterLike, channel: UpdateChannel): void {
    updater.setFeedURL({ provider: "generic", url: feedUrlForChannel(channel) });
    updater.allowPrerelease = channel !== "stable";
    updater.allowDowngrade = false;
  }

  private bindUpdater(updater: AutoUpdaterLike): void {
    updater.on("checking-for-update", () => {
      this.state = reduceUpdate(this.state, { type: "checking" });
      this.emit();
    });
    updater.on("update-available", (info: unknown) => {
      const version = String((info as { version?: string })?.version ?? "");
      if (this.prefs.channel === "stable" && version && !versionMatchesChannel(version, "stable")) {
        this.state = reduceUpdate(this.state, { type: "not_available" });
        this.emit();
        return;
      }
      const notes = String((info as { releaseNotes?: string })?.releaseNotes ?? "");
      const date = String((info as { releaseDate?: string })?.releaseDate ?? "");
      this.state = reduceUpdate(this.state, { type: "available", version, notes, date });
      void this.report("update_available");
      this.emit();
    });
    updater.on("update-not-available", () => {
      this.state = reduceUpdate(this.state, { type: "not_available" });
      this.emit();
    });
    updater.on("download-progress", (p: unknown) => {
      const o = p as { percent?: number; transferred?: number; total?: number; bytesPerSecond?: number };
      this.state = reduceUpdate(this.state, {
        type: "progress",
        progress: {
          percent: Number(o.percent ?? 0),
          transferred: Number(o.transferred ?? 0),
          total: Number(o.total ?? 0),
          bytesPerSecond: o.bytesPerSecond != null ? Number(o.bytesPerSecond) : undefined,
        },
      });
      this.emit();
    });
    updater.on("update-downloaded", (info: unknown) => {
      const version = String((info as { version?: string })?.version ?? this.state.availableVersion ?? "");
      this.state = reduceUpdate(this.state, { type: "downloaded", version });
      void this.report("update_downloaded");
      this.emit();
    });
    updater.on("error", (err: unknown) => this.onError(err));
  }

  private async feedReachable(): Promise<boolean> {
    const url = `${feedUrlForChannel(this.prefs.channel)}${latestManifestName(this.opts.platform)}`;
    try {
      const fetchImpl = this.opts.fetchImpl ?? fetch;
      const res = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(8000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private onError(err: unknown): void {
    const raw = err instanceof Error ? err.message : String(err ?? "error");
    this.opts.log?.("update.error", { message: raw.slice(0, 240) });
    if (isTransientUpdateFailure(raw) && !this.state.required) {
      this.state = reduceUpdate(this.state, { type: "not_available" });
      this.emit();
      return;
    }
    this.state = reduceUpdate(this.state, { type: "error", message: raw });
    void this.report("update_error");
    this.emit();
  }

  private async refreshPolicy(): Promise<void> {
    const { backendUrl, apiKey } = await this.opts.getBackend();
    const base = String(backendUrl || "").replace(/\/+$/, "");
    if (!base) return;
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const url = `${base}/api/v1/releases/current?channel=${encodeURIComponent(this.prefs.channel)}`;
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const body = (await res.json()) as ControlPlanePolicy;
    const paused = body.paused === true;
    const rollout = body.rolloutPercent ?? 100;
    const eligible = !paused && inStagedRollout(rollout, this.prefs.installationId);
    const latest = eligible ? body.latest : undefined;
    const required = body.required === true && Boolean(body.minimumSupported);
    this.state = reduceUpdate(this.state, {
      type: "policy",
      required,
      minimumSupportedVersion: body.minimumSupported,
      latest,
      notes: body.notes,
    });
    this.emit();
  }

  private async report(event: string): Promise<void> {
    try {
      const { backendUrl, apiKey } = await this.opts.getBackend();
      const base = String(backendUrl || "").replace(/\/+$/, "");
      if (!base || !apiKey) return;
      const fetchImpl = this.opts.fetchImpl ?? fetch;
      await fetchImpl(`${base}/api/v1/releases/telemetry`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          installationId: this.prefs.installationId,
          platform: this.opts.platform,
          arch: this.opts.arch,
          version: this.state.currentVersion,
          channel: this.prefs.channel,
          event,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      /* telemetry is best-effort */
    }
  }

  private emit(): void {
    this.opts.send(UPDATE_IPC.changed, this.getState());
  }
}

async function defaultLoadUpdater(): Promise<AutoUpdaterLike | null> {
  try {
    const mod = await import("electron-updater");
    return mod.autoUpdater as unknown as AutoUpdaterLike;
  } catch {
    return null;
  }
}

