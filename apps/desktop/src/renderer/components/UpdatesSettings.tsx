import React, { useEffect, useState } from "react";
import type { DesktopUpdateState } from "../update/desktopUpdateTypes";
import { setRequiredDesktopUpdate } from "../update/updateGate";
export { cloudMissionsBlockedByUpdate } from "../update/desktopUpdateTypes";

function orvynUpdates() {
  return (window.orvyn as { updates?: UpdatesBridge }).updates;
}

interface UpdatesBridge {
  getState(): Promise<DesktopUpdateState>;
  check(): Promise<DesktopUpdateState>;
  download(): Promise<DesktopUpdateState>;
  restartAndInstall(opts?: { force?: boolean }): Promise<{ ok: boolean; code?: string; message?: string }>;
  installOnExit(): Promise<DesktopUpdateState>;
  setChannel(channel: string): Promise<DesktopUpdateState>;
  setAutoDownload(v: boolean): Promise<DesktopUpdateState>;
  setAutoCheck(v: boolean): Promise<DesktopUpdateState>;
  setInstallOnExit(v: boolean): Promise<DesktopUpdateState>;
  setWorkBusy(v: boolean): Promise<{ ok: boolean }>;
  dismiss(): Promise<DesktopUpdateState>;
  onChange(cb: (state: DesktopUpdateState) => void): () => void;
}

function ago(ts?: number): string {
  if (!ts) return "Never";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)} minutes ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hours ago`;
  return `${Math.floor(s / 86400)} days ago`;
}

function statusLabel(s: DesktopUpdateState): string {
  if (s.required) return "Update required";
  switch (s.status) {
    case "checking": return "Checking…";
    case "available": return `Update available · ${s.availableVersion}`;
    case "downloading": return `Downloading ${s.availableVersion ?? ""}`.trim();
    case "downloaded": return `${s.availableVersion ?? "Update"} is ready`;
    case "not_available": return "You're up to date";
    case "error": return s.error ?? "Couldn't check for updates";
    default: return "Idle";
  }
}

export function UpdatesSettings() {
  const api = orvynUpdates();
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!api) return;
    void api.getState().then(setState);
    return api.onChange(setState);
  }, [api]);
  if (!api) {
    return (
      <section>
        <h1>Updates</h1>
        <p className="settings-lead">This ORVYN build does not include the updater bridge.</p>
      </section>
    );
  }
  const s = state;
  return (
    <section className="updates-settings">
      <h1>ORVYN Updates</h1>
      <p className="settings-lead">Installed ORVYN can check a signed HTTPS feed. Cloud services stay independent of this desktop version.</p>
      <dl className="updates-dl">
        <dt>Installed Version</dt>
        <dd>{s?.currentVersion ?? "—"}</dd>
        <dt>Latest available</dt>
        <dd>{s?.availableVersion ?? "—"}</dd>
        <dt>Current state</dt>
        <dd>{s ? statusLabel(s) : "—"}</dd>
        <dt>Last checked</dt>
        <dd>{ago(s?.lastCheckedAt)}</dd>
      </dl>
      <fieldset className="updates-fieldset">
        <legend>Channel</legend>
        {(["stable", "beta", "canary"] as const).map((ch) => (
          <label key={ch} className="updates-radio">
            <input
              type="radio"
              name="update-channel"
              checked={s?.channel === ch}
              onChange={() => void api.setChannel(ch)}
            />
            {ch === "stable" ? "Stable" : ch === "beta" ? "Beta" : "Canary"}
            {ch === "canary" ? <span className="settings-lead"> Internal early builds. Policy can restrict this later.</span> : null}
          </label>
        ))}
      </fieldset>
      <label className="updates-check">
        <input type="checkbox" checked={s?.autoCheck !== false} onChange={(e) => void api.setAutoCheck(e.target.checked)} />
        Check automatically
      </label>
      <label className="updates-check">
        <input type="checkbox" checked={s?.autoDownload === true} onChange={(e) => void api.setAutoDownload(e.target.checked)} />
        Download in background
      </label>
      <fieldset className="updates-fieldset">
        <legend>Installation</legend>
        <label className="updates-radio">
          <input type="radio" name="install-mode" checked={!s?.installOnExit} onChange={() => void api.setInstallOnExit(false)} />
          Ask before restart
        </label>
        <label className="updates-radio">
          <input type="radio" name="install-mode" checked={s?.installOnExit !== false} onChange={() => void api.setInstallOnExit(true)} />
          Install when ORVYN closes
        </label>
      </fieldset>
      <button
        type="button"
        className="settings-back"
        style={{ marginTop: 16, width: "fit-content" }}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try { setState(await api.check()); } finally { setBusy(false); }
        }}
      >
        Check for Updates
      </button>
      {!s?.packaged ? <p className="settings-lead">Unpackaged development builds check policy only; installer updates apply to signed ORVYN installs.</p> : null}
    </section>
  );
}

export function UpdateBanner({ missionActive }: { missionActive: boolean }) {
  const api = orvynUpdates();
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!api) return;
    void api.getState().then(setState);
    return api.onChange(setState);
  }, [api]);
  useEffect(() => {
    if (!api) return;
    void api.setWorkBusy(missionActive);
  }, [api, missionActive]);
  useEffect(() => {
    setRequiredDesktopUpdate(Boolean(state?.required));
  }, [state?.required]);
  if (!api || !state?.required) return null;

  async function restart() {
    if (missionActive && !confirm) {
      setConfirm(true);
      setMessage("A mission is running. Stop it or confirm restart — work in progress will be interrupted.");
      return;
    }
    const out = await api!.restartAndInstall({ force: confirm && missionActive });
    if (!out.ok) setMessage(out.message ?? "Couldn't restart ORVYN.");
  }

  return (
    <div className="update-banner update-banner--required" role="alertdialog" aria-labelledby="orvyn-required-update">
      <div className="update-banner__card">
        <h2 id="orvyn-required-update">ORVYN update required</h2>
        <p>Your installed version is no longer supported. Local projects stay on this computer. Cloud missions stay paused until you update.</p>
        <p className="settings-lead">
          Installed: {state.currentVersion}<br />
          Required: {state.minimumSupportedVersion ?? "newer"} or newer<br />
          Latest: {state.availableVersion ?? "—"}
        </p>
        {state.releaseNotes ? <p>{state.releaseNotes}</p> : null}
        {state.status === "downloading" ? <Progress state={state} /> : null}
        {state.status === "downloaded" ? (
          <div className="update-banner__actions">
            <button type="button" onClick={() => void api.installOnExit()}>Install When ORVYN Closes</button>
            <button type="button" onClick={() => void restart()}>Restart &amp; Install</button>
          </div>
        ) : (
          <div className="update-banner__actions">
            <button type="button" onClick={() => void api.download()}>Update ORVYN</button>
            <button type="button" onClick={() => window.orvyn.window.close()}>Quit</button>
          </div>
        )}
        {message ? <p className="settings-lead">{message}</p> : null}
      </div>
    </div>
  );
}

function RefreshMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 12a8 8 0 0 0-13.7-5.7" stroke="url(#ov-upd-g)" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M6.3 4.2v4.1h4.1" stroke="url(#ov-upd-g)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 12a8 8 0 0 0 13.7 5.7" stroke="url(#ov-upd-g)" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M17.7 19.8v-4.1h-4.1" stroke="url(#ov-upd-g)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      <defs>
        <linearGradient id="ov-upd-g" x1="4" y1="4" x2="20" y2="20">
          <stop stopColor="#c4b5fd" />
          <stop offset="1" stopColor="#67e8f9" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/** Compact card under Auto in the nav — matches the approved mockup. */
export function NavUpdateCard({
  missionActive,
  onViewNotes,
}: {
  missionActive: boolean;
  onViewNotes?: () => void;
}) {
  const api = orvynUpdates();
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!api) return;
    void api.getState().then(setState);
    return api.onChange(setState);
  }, [api]);
  useEffect(() => {
    if (!api) return;
    void api.setWorkBusy(missionActive);
  }, [api, missionActive]);
  const s = state;
  const ready = s && (s.status === "available" || s.status === "downloading" || s.status === "downloaded");
  if (!api || !s || s.required || !ready) return null;
  const version = s.availableVersion ?? "";
  const subtitle =
    s.status === "downloading"
      ? `Downloading ORVYN v${version}… ${Math.round(s.progress?.percent ?? 0)}%`
      : `ORVYN v${version} is ready to install`;

  async function primary() {
    if (s!.status === "downloaded") {
      if (missionActive && !confirm) {
        setConfirm(true);
        setMessage("A mission is running. Confirm to restart anyway.");
        return;
      }
      const out = await api!.restartAndInstall({ force: confirm && missionActive });
      if (!out.ok) setMessage(out.message ?? "Couldn't restart ORVYN.");
      return;
    }
    await api!.download();
  }

  return (
    <div className="ov-update" role="status">
      <div className="ov-update__row">
        <span className="ov-update__icon"><RefreshMark /></span>
        <span className="ov-update__copy">
          <span className="ov-update__title">New Update Ready</span>
          <span className="ov-update__sub">{subtitle}</span>
        </span>
      </div>
      <div className="ov-update__actions">
        <button type="button" className="ov-update__cta" disabled={s.status === "downloading"} onClick={() => void primary()}>
          {s.status === "downloading" ? "Downloading…" : "Update Now"}
        </button>
        <button
          type="button"
          className="ov-update__ghost"
          onClick={() => {
            if (s.releaseNotes) setNotesOpen((v) => !v);
            else onViewNotes?.();
          }}
        >
          View Notes
        </button>
      </div>
      {notesOpen && s.releaseNotes ? <p className="ov-update__notes">{s.releaseNotes}</p> : null}
      {message ? <p className="ov-update__notes">{message}</p> : null}
    </div>
  );
}

function Progress({ state }: { state: DesktopUpdateState }) {
  const pct = Math.round(state.progress?.percent ?? 0);
  const total = state.progress?.total ?? 0;
  const done = state.progress?.transferred ?? 0;
  return (
    <div>
      <div className="update-progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} role="progressbar">
        <span style={{ width: `${pct}%` }} />
      </div>
      <p className="settings-lead">{pct}%{total ? ` · ${(done / 1e6).toFixed(1)} MB / ${(total / 1e6).toFixed(1)} MB` : ""}</p>
    </div>
  );
}

