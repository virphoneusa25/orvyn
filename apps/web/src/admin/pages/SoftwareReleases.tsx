import { api } from "../../lib/api";
import { invalidate, useQuery } from "../query";
import { Card, Empty, ErrorBox, SkeletonRows } from "../components/UI";
import { A } from "../components/AIcons";
import { useAdmin, canDo } from "../AdminApp";
import { useState } from "react";

interface Release {
  id: string;
  version: string;
  channel: string;
  title: string;
  notes: string;
  publishedAt: number | null;
  required: boolean;
  minimumSupportedVersion: string | null;
  rolloutPercent: number;
  status: string;
  artifacts: { platform: string; filename: string; url: string; size?: number }[];
}

interface Install {
  installationId: string;
  platform: string;
  arch: string;
  version: string;
  channel: string;
  lastEvent: string | null;
  lastSeen: number;
}

interface Summary {
  channels: { stable: string | null; beta: string | null; canary: string | null };
  adoption: { version: string; count: number; percent: number }[];
  releases: Release[];
  failures: number;
  installations: Install[];
}

export function SoftwareReleases() {
  const me = useAdmin();
  const q = useQuery<Summary>("/admin/releases", { staleMs: 10_000 });
  const [sel, setSel] = useState<string | null>(null);
  const release = q.data?.releases.find((r) => r.id === sel) ?? q.data?.releases[0] ?? null;
  const canMeta = canDo(me, "support.write");
  const canRequired = canDo(me, "staff.manage");
  const installs = q.data?.installations ?? [];
  return (
    <div className="a-acct-row2" style={{ marginTop: 0 }}>
      <div>
        <div className="a-grid3" style={{ marginBottom: 16 }}>
          <Card title="Current Stable"><b style={{ fontSize: 22 }}>{q.data?.channels.stable ?? "—"}</b></Card>
          <Card title="Current Beta"><b style={{ fontSize: 22 }}>{q.data?.channels.beta ?? "—"}</b></Card>
          <Card title="Current Canary"><b style={{ fontSize: 22 }}>{q.data?.channels.canary ?? "—"}</b></Card>
        </div>
        <Card title="Current installs" sub="The two live desktops appear here once recorded or after they phone home.">
          <ErrorBox error={q.error} retry={q.reload} />
          {!q.data ? <SkeletonRows /> : installs.length === 0 ? (
            <Empty icon="cpu" title="No desktop installs recorded" />
          ) : (
            <table className="a-table">
              <thead><tr><th>Version</th><th>Channel</th><th>Platform</th><th>Last seen</th></tr></thead>
              <tbody>{installs.map((i) => (
                <tr key={i.installationId}>
                  <td><b>{i.version}</b><small>{i.lastEvent ?? "recorded"}</small></td>
                  <td>{i.channel}</td>
                  <td>{i.platform}/{i.arch}</td>
                  <td>{new Date(i.lastSeen).toLocaleString()}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </Card>
        <Card title="Stable adoption" sub={q.data ? `${q.data.failures} update failures recorded` : undefined}>
          {!q.data ? <SkeletonRows /> : q.data.adoption.length === 0 ? (
            <Empty icon="bars" title="No desktop telemetry yet" />
          ) : (
            <table className="a-table">
              <thead><tr><th>Version</th><th className="num">Installs</th><th className="num">Share</th></tr></thead>
              <tbody>{q.data.adoption.map((a) => (
                <tr key={a.version}><td>{a.version}</td><td className="num">{a.count}</td><td className="num">{a.percent}%</td></tr>
              ))}</tbody>
            </table>
          )}
        </Card>
        <Card title="Releases" sub="CI publishes signed installers. Super admins can record the versions already installed so rollout and required updates can be tested.">
          {!q.data ? <SkeletonRows /> : q.data.releases.length === 0 ? (
            <Empty icon="layers" title="No desktop releases recorded" />
          ) : (
            <table className="a-table">
              <thead><tr><th>Version</th><th>Channel</th><th>Status</th><th>Rollout</th><th>Required</th></tr></thead>
              <tbody>{q.data.releases.map((r) => (
                <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => setSel(r.id)}>
                  <td><b>{r.version}</b><small>{r.publishedAt ? new Date(r.publishedAt).toLocaleString() : "Draft"}</small></td>
                  <td>{r.channel}</td>
                  <td>{r.status}</td>
                  <td>{r.rolloutPercent}%</td>
                  <td>{r.required ? "Yes" : "Optional"}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </Card>
      </div>
      <div style={{ display: "grid", gap: 16 }}>
        {canRequired ? (
          <RecordLiveInstalls onSaved={() => invalidate("/admin/releases")} />
        ) : null}
        {!release ? <Card title="Release" sub="Signing keys never appear here."><Empty icon="layers" title="No desktop releases recorded" /></Card> : (
          <Card title={`ORVYN ${release.version}`} sub="Signing keys never appear here.">
            <ReleaseEditor release={release} canMeta={canMeta} canRequired={canRequired} onSaved={() => invalidate("/admin/releases")} />
          </Card>
        )}
      </div>
    </div>
  );
}

function RecordLiveInstalls({ onSaved }: { onSaved: () => void }) {
  const [version, setVersion] = useState("0.2.0");
  const [channel, setChannel] = useState("stable");
  const [platform, setPlatform] = useState("win32");
  const [count, setCount] = useState("2");
  const [notes, setNotes] = useState("Recorded from the two current live installs for rollout testing.");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api("/admin/releases", {
        method: "POST",
        body: { version, channel, notes, status: "published", title: `ORVYN ${version}` },
      });
      const n = Math.min(2, Math.max(1, Number(count) || 2));
      for (let i = 0; i < n; i++) {
        await api("/admin/releases/installs", {
          method: "POST",
          body: {
            version,
            channel,
            platform,
            arch: "x64",
            event: "app_started",
            installationId: `live-install-${i + 1}-${version.replace(/[^0-9A-Za-z.-]/g, "")}`.slice(0, 80),
          },
        });
      }
      setMsg(`Recorded ${n} live install${n === 1 ? "" : "s"} on ${channel} ${version}. You can now edit rollout and mark required.`);
      onSaved();
    } catch (err: unknown) {
      setMsg(err instanceof Error ? err.message : "Could not record the installs.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Record live installs" sub="Use this for the two desktops already running. It does not upload binaries.">
      <div style={{ display: "grid", gap: 10 }}>
        <div className="a-field"><label>Installed version</label><input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="0.2.0" /></div>
        <div className="a-field"><label>Channel</label>
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="stable">stable</option>
            <option value="beta">beta</option>
            <option value="canary">canary</option>
          </select>
        </div>
        <div className="a-field"><label>Platform</label>
          <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
            <option value="win32">Windows</option>
            <option value="darwin">macOS</option>
            <option value="linux">Linux</option>
          </select>
        </div>
        <div className="a-field"><label>How many live installs</label>
          <select value={count} onChange={(e) => setCount(e.target.value)}>
            <option value="1">1</option>
            <option value="2">2</option>
          </select>
        </div>
        <div className="a-field"><label>Notes</label><textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        <button className="btn btn--sm" disabled={busy} onClick={() => void run()}>
          {busy ? "Recording…" : "Record the two current installs"}
        </button>
        {msg ? <p className="muted">{msg}</p> : null}
      </div>
    </Card>
  );
}

function ReleaseEditor({ release, canMeta, canRequired, onSaved }: { release: Release; canMeta: boolean; canRequired: boolean; onSaved: () => void }) {
  const [notes, setNotes] = useState(release.notes);
  const [rollout, setRollout] = useState(String(release.rolloutPercent));
  const [min, setMin] = useState(release.minimumSupportedVersion ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const save = async (body: Record<string, unknown>) => {
    try {
      await api(`/admin/releases/${release.id}`, { method: "PATCH", body });
      setMsg("Saved.");
      onSaved();
    } catch (err: unknown) {
      setMsg(err instanceof Error ? err.message : "Could not save.");
    }
  };
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <p className="muted" style={{ margin: 0 }}>{release.title} · {release.channel} · {release.status}</p>
      <div className="a-field"><label>Release notes</label><textarea rows={6} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!canMeta} /></div>
      {canMeta ? <button className="btn btn--sm" onClick={() => void save({ notes })}>Save notes</button> : null}
      <div className="a-field"><label>Rollout</label>
        <select value={rollout} disabled={!canMeta} onChange={(e) => setRollout(e.target.value)}>
          {[0, 5, 10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}%</option>)}
        </select>
      </div>
      {canMeta ? <button className="btn btn--sm" onClick={() => void save({ rolloutPercent: Number(rollout) })}>Save rollout</button> : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {canMeta && release.status !== "paused" ? <button className="btn btn--sm" onClick={() => void save({ status: "paused" })}><A.pause size={14} /> Pause rollout</button> : null}
        {canMeta && release.status === "paused" ? <button className="btn btn--sm" onClick={() => void save({ status: "published" })}><A.play size={14} /> Resume</button> : null}
      </div>
      <div className="a-field"><label>Minimum supported version</label>
        <input value={min} disabled={!canRequired} onChange={(e) => setMin(e.target.value)} placeholder="0.2.0" />
      </div>
      {canRequired ? (
        <button className="btn btn--sm btn--danger" onClick={() => void save({ required: true, minimumSupportedVersion: min || release.version })}>
          Mark required (super admin)
        </button>
      ) : <p className="muted">Only a super admin can mark a security update required.</p>}
      <div>
        <b>Artifacts</b>
        {release.artifacts.length === 0 ? <p className="muted">Recorded by the desktop release pipeline. Unsigned uploads are not accepted here.</p> : release.artifacts.map((a) => (
          <div key={a.filename} className="a-mono">{a.platform} · {a.filename}</div>
        ))}
      </div>
      {msg ? <p className="muted">{msg}</p> : null}
    </div>
  );
}
