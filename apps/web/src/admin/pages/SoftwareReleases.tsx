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

interface Summary {
  channels: { stable: string | null; beta: string | null; canary: string | null };
  adoption: { version: string; count: number; percent: number }[];
  releases: Release[];
  failures: number;
}

export function SoftwareReleases() {
  const me = useAdmin();
  const q = useQuery<Summary>("/admin/releases", { staleMs: 10_000 });
  const [sel, setSel] = useState<string | null>(null);
  const release = q.data?.releases.find((r) => r.id === sel) ?? q.data?.releases[0] ?? null;
  const canMeta = canDo(me, "support.write");
  const canRequired = canDo(me, "staff.manage");
  return (
    <div className="a-acct-row2" style={{ marginTop: 0 }}>
      <div>
        <div className="a-grid3" style={{ marginBottom: 16 }}>
          <Card title="Current Stable"><b style={{ fontSize: 22 }}>{q.data?.channels.stable ?? "—"}</b></Card>
          <Card title="Current Beta"><b style={{ fontSize: 22 }}>{q.data?.channels.beta ?? "—"}</b></Card>
          <Card title="Current Canary"><b style={{ fontSize: 22 }}>{q.data?.channels.canary ?? "—"}</b></Card>
        </div>
        <Card title="Stable adoption" sub={q.data ? `${q.data.failures} update failures recorded` : undefined}>
          <ErrorBox error={q.error} retry={q.reload} />
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
        <Card title="Releases" sub="CI publishes signed installers. This page edits metadata and rollout only.">
          {!q.data ? <SkeletonRows /> : (
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
      <Card title={release ? `ORVYN ${release.version}` : "Release"} sub="Signing keys never appear here.">
        {!release ? <Empty icon="layers" title="No desktop releases recorded" /> : (
          <ReleaseEditor release={release} canMeta={canMeta} canRequired={canRequired} onSaved={() => invalidate("/admin/releases")} />
        )}
      </Card>
    </div>
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
        <input value={min} disabled={!canRequired} onChange={(e) => setMin(e.target.value)} placeholder="1.7.5" />
      </div>
      {canRequired ? (
        <button className="btn btn--sm btn--danger" onClick={() => void save({ required: true, minimumSupportedVersion: min })}>
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
