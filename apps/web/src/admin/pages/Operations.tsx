import { useState } from "react";
import { api } from "../../lib/api";
import { navigate } from "../../lib/router";
import { useStore } from "../../lib/store";
import { invalidate, useDebounced, useQuery } from "../query";
import { fmtAgo, fmtCompact, fmtDate, fmtNum, fmtUsd } from "../format";
import { A } from "../components/AIcons";
import { BarChart, Card, Empty, ErrorBox, SkeletonRows } from "../components/UI";
import { canDo, useAdmin } from "../AdminApp";

export function ProviderCosts() {
  const [days, setDays] = useState(30);
  const q = useQuery<{ totalUsd: number; creditValueUsd: number; marginPct: number | null; byClass: { name: string; usd: number; share: number }[]; models: { provider: string; model: string; calls: number; tokens: number; costUsd: number; credits: number; creditValueUsd: number; marginPct: number | null }[]; daily: { day: string; costUsd: number }[]; note: string }>(`/admin/provider-costs?days=${days}`);
  return (
    <>
      <ErrorBox error={q.error} retry={q.reload} />
      <div className="a-grid4">
        <div className="a-card"><div className="a-kpi__label">Provider cost</div><div className="a-kpi__value">{q.data ? fmtUsd(q.data.totalUsd) : "…"}</div><div className="a-kpi__sub">last {days} days · internal</div></div>
        <div className="a-card"><div className="a-kpi__label">Credit value charged</div><div className="a-kpi__value">{q.data ? fmtUsd(q.data.creditValueUsd) : "…"}</div><div className="a-kpi__sub">{q.data?.note}</div></div>
        <div className="a-card"><div className="a-kpi__label">Gross margin</div><div className="a-kpi__value">{q.data?.marginPct === null || !q.data ? "—" : `${q.data.marginPct}%`}</div><div className="a-kpi__sub">(value − cost) / value</div></div>
        <div className="a-card"><div className="a-kpi__label">Range</div><div className="a-seg" style={{ marginTop: 8 }}>{[7, 30, 90].map((d) => <button key={d} className={days === d ? "is-on" : ""} onClick={() => setDays(d)}>{d} days</button>)}</div></div>
      </div>
      <Card title="Daily provider cost" className="" >{q.data ? <BarChart points={q.data.daily.map((d) => ({ day: d.day, value: d.costUsd }))} label="Provider cost per day" format={(n) => `$${n < 10 ? n.toFixed(2) : Math.round(n)}`} /> : <SkeletonRows rows={3} h={40} />}</Card>
      <Card title="By provider and model" sub="Internal — never shown to customers">
        {!q.data ? <SkeletonRows /> : !q.data.models.length ? <Empty icon="dollar" title="No usage in this range" /> : (
          <div className="a-table-wrap"><table className="a-table" data-testid="costs-table">
            <thead><tr><th>Provider</th><th>Model</th><th className="num">Calls</th><th className="num">Tokens</th><th className="num">Cost</th><th className="num">Credits</th><th className="num">Credit value</th><th className="num">Margin</th></tr></thead>
            <tbody>{q.data.models.map((m) => <tr key={`${m.provider}${m.model}`} style={{ cursor: "default" }}><td>{m.provider}</td><td className="a-mono">{m.model}</td><td className="num">{fmtNum(m.calls)}</td><td className="num">{fmtCompact(m.tokens)}</td><td className="num">{fmtUsd(m.costUsd, 4)}</td><td className="num">{fmtNum(m.credits)}</td><td className="num">{fmtUsd(m.creditValueUsd)}</td><td className="num" style={{ color: (m.marginPct ?? 0) < 0 ? "#f87171" : "#86efac" }}>{m.marginPct === null ? "—" : `${m.marginPct}%`}</td></tr>)}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}

interface Health { status: string; checkedAt: number; checks: { id: string; name: string; status: string; detail: string; latencyMs?: number }[]; providers: { provider: string; score: number; coolingDown: boolean; lastError?: string }[] }

export function SystemHealth() {
  const q = useQuery<Health>("/admin/health", { refreshMs: 30_000, staleMs: 10_000 });
  return (
    <>
      <ErrorBox error={q.error} retry={q.reload} />
      <Card title="Services" sub={q.data ? `Checked ${fmtAgo(q.data.checkedAt)} · refreshes every 30 s` : ""} action={<button className="btn btn--sm" style={{ marginLeft: "auto" }} onClick={q.reload}><A.refresh size={14} /> Check now</button>}>
        {!q.data ? <SkeletonRows rows={8} /> : (
          <table className="a-table" data-testid="health-table"><thead><tr><th>Service</th><th>Status</th><th>Detail</th><th className="num">Latency</th></tr></thead>
            <tbody>{q.data.checks.map((c) => <tr key={c.id} style={{ cursor: "default" }}><td><span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><i className={`adm-dot adm-dot--${c.status}`} style={{ width: 9, height: 9 }} />{c.name}</span></td><td style={{ textTransform: "capitalize" }}>{c.status.replace("_", " ")}</td><td className="muted">{c.detail}</td><td className="num">{c.latencyMs !== undefined ? `${c.latencyMs} ms` : "—"}</td></tr>)}</tbody></table>
        )}
      </Card>
      <Card title="Model providers" sub="Routing health (internal)">
        {!q.data ? <SkeletonRows rows={3} /> : !q.data.providers.length ? <Empty icon="heart" title="No provider errors recorded since start" /> : (
          <table className="a-table"><thead><tr><th>Provider</th><th className="num">Health</th><th>State</th><th>Last error</th></tr></thead>
            <tbody>{q.data.providers.map((p) => <tr key={p.provider} style={{ cursor: "default" }}><td>{p.provider}</td><td className="num">{Math.round(p.score * 100)}%</td><td>{p.coolingDown ? "Cooling down" : "Serving"}</td><td className="muted">{p.lastError?.slice(0, 120) ?? "—"}</td></tr>)}</tbody></table>
        )}
      </Card>
    </>
  );
}

export function Workers() {
  const q = useQuery<{ workers: { online: number; total: number }; runs: { running: number; queued: number; loadedAccounts: number }; sessions: { signedIn: number; active15m: number; activeUsers24h: number; viewAs: number } }>("/admin/workers", { refreshMs: 30_000 });
  const d = q.data;
  const tile = (label: string, value: string, sub: string) => <div className="a-card"><div className="a-kpi__label">{label}</div><div className="a-kpi__value">{value}</div><div className="a-kpi__sub">{sub}</div></div>;
  return (
    <>
      <ErrorBox error={q.error} retry={q.reload} />
      {!d ? <SkeletonRows rows={2} h={90} /> : (
        <>
          <div className="a-grid4">
            {tile("Execution workers", `${d.workers.online}/${d.workers.total}`, "online / registered")}
            {tile("Runs", fmtNum(d.runs.running), `running · ${fmtNum(d.runs.queued)} queued`)}
            {tile("Accounts in memory", fmtNum(d.runs.loadedAccounts), "loaded on this server")}
            {tile("Signed-in sessions", fmtNum(d.sessions.signedIn), `${fmtNum(d.sessions.active15m)} active in 15 min`)}
          </div>
          <div className="a-grid4" style={{ marginTop: 14 }}>
            {tile("Active users", fmtNum(d.sessions.activeUsers24h), "last 24 hours")}
            {tile("Support views", fmtNum(d.sessions.viewAs), "open read-only customer views")}
          </div>
        </>
      )}
    </>
  );
}

export function Backups() {
  const q = useQuery<{ visible: boolean; backup: { status: string; stamp: string; tag: string; size: string | null; encrypted: boolean; offHost: boolean; at: number } | null; drill: { status: string; backup: string; accounts: string; at: number } | null; history: { status: string; stamp: string; tag: string; size: string | null; encrypted: boolean; offHost: boolean; at: number }[] }>("/admin/backups");
  const d = q.data;
  return (
    <>
      <ErrorBox error={q.error} retry={q.reload} />
      {!d ? <SkeletonRows rows={3} h={80} /> : !d.visible ? (
        <Card title="Backups"><Empty icon="db" title="No backup status yet">The hourly backup and weekly restore drill write their status here after their next run.</Empty></Card>
      ) : (
        <>
          <div className="a-grid4">
            <div className="a-card"><div className="a-kpi__label">Last backup</div><div className="a-kpi__value" style={{ color: d.backup?.status === "ok" ? "#4ade80" : "#f87171" }}>{d.backup?.status === "ok" ? "OK" : d.backup?.status ?? "—"}</div><div className="a-kpi__sub">{d.backup ? `${fmtAgo(d.backup.at)} · ${d.backup.tag}` : ""}</div></div>
            <div className="a-card"><div className="a-kpi__label">Size</div><div className="a-kpi__value">{d.backup?.size ?? "—"}</div><div className="a-kpi__sub">{d.backup?.encrypted ? "Encrypted" : "Not encrypted"}</div></div>
            <div className="a-card"><div className="a-kpi__label">Off-host copy</div><div className="a-kpi__value" style={{ color: d.backup?.offHost ? "#4ade80" : "#fbbf24" }}>{d.backup?.offHost ? "Yes" : "No"}</div><div className="a-kpi__sub">{d.backup?.offHost ? "Uploaded" : "Configure BACKUP_S3_URI"}</div></div>
            <div className="a-card"><div className="a-kpi__label">Restore drill</div><div className="a-kpi__value" style={{ color: d.drill?.status === "pass" ? "#4ade80" : d.drill ? "#f87171" : undefined }}>{d.drill ? d.drill.status.toUpperCase() : "—"}</div><div className="a-kpi__sub">{d.drill ? `${fmtAgo(d.drill.at)} · ${d.drill.accounts} accounts restored` : "Not run yet"}</div></div>
          </div>
          <Card title="History" className="" >
            {!d.history.length ? <Empty icon="db" title="No history yet" /> : (
              <table className="a-table"><thead><tr><th>When</th><th>Backup</th><th>Status</th><th>Size</th><th>Encrypted</th><th>Off-host</th></tr></thead>
                <tbody>{d.history.map((h) => <tr key={h.stamp + h.at} style={{ cursor: "default" }}><td>{fmtDate(h.at)} {new Date(h.at).toLocaleTimeString()}</td><td className="a-mono">{h.stamp}</td><td>{h.status}</td><td>{h.size ?? "—"}</td><td>{h.encrypted ? "Yes" : "No"}</td><td>{h.offHost ? "Yes" : "No"}</td></tr>)}</tbody></table>
            )}
          </Card>
        </>
      )}
    </>
  );
}

export function AuditLogs() {
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [cursors, setCursors] = useState<number[]>([]);
  const da = useDebounced(actor.trim(), 300);
  const before = cursors[cursors.length - 1];
  const q = useQuery<{ audit: { id: string; at: number; actorEmail: string; action: string; title: string; customer: string | null; tenantId: string | null; detail: Record<string, unknown>; ip: string | null }[] }>(`/admin/audit?limit=50${action ? `&action=${action}` : ""}${da ? `&actor=${encodeURIComponent(da)}` : ""}${before ? `&before=${before}` : ""}`);
  return (
    <Card>
      <div className="a-filters">
        <select className="input select" value={action} onChange={(e) => { setAction(e.target.value); setCursors([]); }} aria-label="Action type">
          <option value="">All actions</option><option value="credits.">Credits</option><option value="plan.">Plans</option><option value="account.">Pause / reactivate</option><option value="support.">Support</option><option value="staff.">Staff</option><option value="customer.">Customers</option><option value="profile.">Profile</option>
        </select>
        <label className="a-mini-search"><A.user size={16} /><input value={actor} onChange={(e) => { setActor(e.target.value); setCursors([]); }} placeholder="Staff email" aria-label="Filter by staff" /></label>
        <span className="muted" style={{ fontSize: 12.5 }}>Append-only — entries can't be edited or deleted.</span>
      </div>
      <ErrorBox error={q.error} retry={q.reload} />
      {!q.data ? <SkeletonRows rows={8} /> : !q.data.audit.length ? <Empty icon="audit" title="No staff actions match" /> : (
        <div className="a-table-wrap"><table className="a-table" data-testid="audit-table">
          <thead><tr><th>When</th><th>Action</th><th>Customer</th><th>Staff</th><th>Details</th><th>IP</th></tr></thead>
          <tbody>{q.data.audit.map((a) => (
            <tr key={a.id} onClick={() => a.tenantId && navigate(`/admin/customers/${a.tenantId}/audit`)}>
              <td>{fmtDate(a.at)}<small>{new Date(a.at).toLocaleTimeString()}</small></td><td>{a.title}</td><td>{a.customer ?? "—"}</td><td>{a.actorEmail}</td>
              <td style={{ maxWidth: 300, whiteSpace: "normal" }}><small>{Object.entries(a.detail).filter(([k]) => k !== "entries").map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ")}</small></td><td className="a-mono">{a.ip ?? ""}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <div className="a-pager" style={{ justifyContent: "flex-end" }}>
        <button disabled={!cursors.length} onClick={() => setCursors(cursors.slice(0, -1))}>Newer</button>
        <button disabled={!q.data || q.data.audit.length < 50} onClick={() => q.data && setCursors([...cursors, q.data.audit[q.data.audit.length - 1]!.at])}>Older</button>
      </div>
    </Card>
  );
}

const ROLES: [string, string, string][] = [["super_admin", "Super Admin", "Everything, including staff and complimentary plans"], ["billing", "Billing Admin", "Plans, credits, provider costs"], ["support", "Support", "Notes, emails, view as customer, pause"], ["readonly", "Read-only", "Every screen, no actions"]];

export function StaffSettings() {
  const me = useAdmin();
  const { toast } = useStore();
  const q = useQuery<{ staff: { userId: string; email: string; name: string | null; role: string; createdAt: number; createdBy: string | null }[] }>("/admin/staff");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("support");
  const [busy, setBusy] = useState(false);
  const manage = canDo(me, "staff.manage");
  const save = async (e: string, r: string) => {
    setBusy(true);
    try { await api("/admin/staff", { method: "POST", body: { email: e, role: r } }); invalidate("/admin/staff"); invalidate("/admin/audit"); toast("Saved."); setEmail(""); }
    catch (err: any) { toast(err.message); } finally { setBusy(false); }
  };
  return (
    <div className="a-acct-row2" style={{ marginTop: 0 }}>
      <Card title="Staff" sub="Access to this Admin Portal">
        <ErrorBox error={q.error} retry={q.reload} />
        {!q.data ? <SkeletonRows /> : (
          <table className="a-table" data-testid="staff-table"><thead><tr><th>Member</th><th>Role</th><th>Added</th><th /></tr></thead>
            <tbody>{q.data.staff.map((s) => (
              <tr key={s.userId} style={{ cursor: "default" }}>
                <td>{s.name ?? s.email}<small>{s.email}</small></td>
                <td>{manage && s.userId !== me.staff.id ? <select className="input select" style={{ height: 32 }} value={s.role} aria-label={`Role for ${s.email}`} onChange={(e) => void save(s.email, e.target.value)}>{ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select> : ROLES.find(([v]) => v === s.role)?.[1]}</td>
                <td>{fmtDate(s.createdAt)}<small>{s.createdBy?.replace(/^env:.*/, "deployment config") ?? ""}</small></td>
                <td>{manage && s.userId !== me.staff.id ? <button className="btn btn--sm btn--danger" onClick={async () => { try { await api(`/admin/staff/${s.userId}`, { method: "DELETE" }); invalidate("/admin/staff"); toast("Removed."); } catch (err: any) { toast(err.message); } }}>Remove</button> : null}</td>
              </tr>
            ))}</tbody></table>
        )}
      </Card>
      <Card title="Add staff member">
        {!manage ? <Empty icon="shield" title="Only a super admin can manage staff" /> : (
          <>
            <p className="muted" style={{ marginTop: 0 }}>They need an ORVYN account first. Staff access is separate from any customer organization role.</p>
            <div className="a-field"><label htmlFor="st-email">Email</label><input id="st-email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            <div className="a-field"><label htmlFor="st-role">Role</label><select id="st-role" className="input select" value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
            <p className="muted" style={{ fontSize: 12.5 }}>{ROLES.find(([v]) => v === role)?.[2]}</p>
            <button className="btn btn--primary" disabled={busy || !email.includes("@")} onClick={() => void save(email.trim(), role)}>Add</button>
          </>
        )}
      </Card>
    </div>
  );
}
