import React, { useEffect, useMemo, useState } from "react";
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
  const s = state;
  const visible = useMemo(() => {
    if (!s) return false;
    if (s.required) return true;
    return s.status === "available" || s.status === "downloading" || s.status === "downloaded" || (s.status === "error" && Boolean(s.error));
  }, [s]);
  if (!api || !s || !visible) return null;

  async function restart() {
    if (missionActive && !confirm) {
      setConfirm(true);
      setMessage("A mission is running. Stop it or confirm restart — work in progress will be interrupted.");
      return;
    }
    const out = await api!.restartAndInstall({ force: confirm && missionActive });
    if (!out.ok) setMessage(out.message ?? "Couldn't restart ORVYN.");
  }

  if (s.required) {
    return (
      <div className="update-banner update-banner--required" role="alertdialog" aria-labelledby="orvyn-required-update">
        <div className="update-banner__card">
          <h2 id="orvyn-required-update">ORVYN update required</h2>
          <p>Your installed version is no longer supported. Local projects stay on this computer. Cloud missions stay paused until you update.</p>
          <p className="settings-lead">
            Installed: {s.currentVersion}<br />
            Required: {s.minimumSupportedVersion ?? "newer"} or newer<br />
            Latest: {s.availableVersion ?? "—"}
          </p>
          {s.releaseNotes ? <p>{s.releaseNotes}</p> : null}
          {s.status === "downloading" ? <Progress state={s} /> : null}
          {s.status === "downloaded" ? (
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

  return (
    <div className="update-banner" role="status">
      <div className="update-banner__card">
        {s.status === "available" ? (
          <>
            <h2>Update available</h2>
            <p>ORVYN {s.availableVersion}</p>
            {s.releaseNotes ? <p>{s.releaseNotes}</p> : null}
            <div className="update-banner__actions">
              <button type="button" onClick={() => void api.dismiss()}>Later</button>
              <button type="button" onClick={() => void api.download()}>Download Update</button>
            </div>
          </>
        ) : null}
        {s.status === "downloading" ? (
          <>
            <h2>Downloading ORVYN {s.availableVersion}</h2>
            <Progress state={s} />
          </>
        ) : null}
        {s.status === "downloaded" ? (
          <>
            <h2>ORVYN {s.availableVersion} is ready</h2>
            <div className="update-banner__actions">
              <button type="button" onClick={() => void api.installOnExit()}>Install When ORVYN Closes</button>
              <button type="button" onClick={() => void restart()}>Restart &amp; Install</button>
            </div>
            {message ? <p className="settings-lead">{message}</p> : null}
          </>
        ) : null}
        {s.status === "error" ? (
          <>
            <h2>Couldn't check for updates</h2>
            <p>{s.error}</p>
            <div className="update-banner__actions">
              <button type="button" onClick={() => void api.dismiss()}>Dismiss</button>
              <button type="button" onClick={() => void api.check()}>Try again</button>
            </div>
          </>
        ) : null}
      </div>
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

