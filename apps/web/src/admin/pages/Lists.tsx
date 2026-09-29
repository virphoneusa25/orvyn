import { useState } from "react";
import { navigate } from "../../lib/router";
import { useDebounced, useQuery } from "../query";
import { fmtAgo, fmtDate, fmtNum, fmtUsd } from "../format";
import { A } from "../components/AIcons";
import { BarChart, Card, CopyId, Empty, ErrorBox, OrgLogo, Pager, SkeletonRows, StatusBadge } from "../components/UI";
import type { CustomerList } from "../components/CustomerTable";

export function Organizations() {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const dq = useDebounced(q.trim(), 300);
  const list = useQuery<CustomerList>(`/admin/organizations?page=${page}&pageSize=25${dq ? `&q=${encodeURIComponent(dq)}` : ""}`);
  return (
    <Card>
      <div className="a-filters"><label className="a-mini-search"><A.search size={16} /><input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search organizations or members…" aria-label="Search organizations" /></label></div>
      <ErrorBox error={list.error} retry={list.reload} />
      {!list.data ? <SkeletonRows rows={8} /> : !list.data.customers.length ? <Empty icon="org" title="No organizations" /> : (
        <div className="a-table-wrap"><table className="a-table">
          <thead><tr><th>Organization</th><th>Type</th><th className="num">Members</th><th>Owner</th><th>Plan</th><th>Status</th><th>Created</th><th>Organization ID</th></tr></thead>
          <tbody>{list.data.customers.map((o) => (
            <tr key={o.id} onClick={() => navigate(`/admin/customers/${o.id}`)}>
              <td><div className="a-org"><OrgLogo name={o.name} seed={o.id} /><b>{o.name}</b></div></td>
              <td>{o.kind === "company" ? "Business" : "Personal"}</td><td className="num">{o.members}</td><td>{o.contact?.email ?? "—"}</td><td>{o.plan.label}</td><td><StatusBadge status={o.status} /></td><td>{fmtDate(o.createdAt)}</td><td onClick={(e) => e.stopPropagation()}><CopyId value={o.organizationId} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {list.data?.total ? <Pager page={page} pageSize={25} total={list.data.total} onPage={setPage} /> : null}
    </Card>
  );
}

interface SubRow { tenantId: string; customer: string; plan: string; subscriptionId: string | null; complimentary: boolean; status: string; period: string | null; mrr: number; renewsAt: number; cancelAtPeriodEnd: boolean }

export function Subscriptions() {
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const q = useQuery<{ total: number; subscriptions: SubRow[] }>(`/admin/subscriptions?page=${page}&pageSize=25${status ? `&status=${status}` : ""}`);
  return (
    <Card>
      <div className="a-tabs">{[["", "All"], ["active", "Active"], ["trialing", "Trial"], ["past_due", "Past Due"], ["canceled", "Cancelled"], ["manual", "Complimentary"]].map(([v, l]) => <button key={v} className={`a-tab${status === v ? " is-on" : ""}`} onClick={() => { setStatus(v!); setPage(1); }}>{l}</button>)}</div>
      <ErrorBox error={q.error} retry={q.reload} />
      {!q.data ? <SkeletonRows rows={8} /> : !q.data.subscriptions.length ? <Empty icon="sub" title="No subscriptions" /> : (
        <div className="a-table-wrap"><table className="a-table">
          <thead><tr><th>Customer</th><th>Plan</th><th>Cycle</th><th>Status</th><th className="num">MRR</th><th>Renews / ends</th><th>Subscription</th></tr></thead>
          <tbody>{q.data.subscriptions.map((s) => (
            <tr key={s.tenantId} onClick={() => navigate(`/admin/customers/${s.tenantId}/subscription`)}>
              <td>{s.customer}</td><td>{s.plan}{s.complimentary ? <small>Complimentary</small> : null}</td><td style={{ textTransform: "capitalize" }}>{s.period ?? "—"}</td>
              <td><span className={`a-badge a-badge--${s.status === "active" ? "active" : s.status === "trialing" ? "trial" : s.status === "canceled" ? "cancelled" : "past_due"}`}>{s.status.replace(/_/g, " ")}</span>{s.cancelAtPeriodEnd ? <small>cancels at renewal</small> : null}</td>
              <td className="num">{fmtUsd(s.mrr)}</td><td>{fmtDate(s.renewsAt)}</td><td onClick={(e) => e.stopPropagation()}><CopyId value={s.subscriptionId} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {q.data?.total ? <Pager page={page} pageSize={25} total={q.data.total} onPage={setPage} /> : null}
    </Card>
  );
}

export function UsageCredits() {
  const [days, setDays] = useState(30);
  const q = useQuery<{ series: { day: string; credits: number; tokens: number; missions: number; chat: number }[]; top: { tenantId: string; name: string; credits: number; events: number; lastAt: number }[]; adjustments: { tenantId: string; customer: string; credits: number; bucket: string; actor: string; reason: string; category: string | null; at: number }[] }>(`/admin/usage?days=${days}`);
  const total = q.data?.series.reduce((a, d) => a + d.credits, 0) ?? 0;
  return (
    <>
      <ErrorBox error={q.error} retry={q.reload} />
      <Card title="Credits used" sub={`${fmtNum(total)} in ${days} days`} action={<div className="a-seg" style={{ marginLeft: "auto" }}>{[7, 30, 90].map((d) => <button key={d} className={days === d ? "is-on" : ""} onClick={() => setDays(d)}>{d} days</button>)}</div>}>
        {q.data ? <BarChart points={q.data.series.map((d) => ({ day: d.day, value: d.credits }))} label="Credits used per day" height={170} /> : <SkeletonRows rows={3} h={50} />}
      </Card>
      <div className="a-acct-row2">
        <Card title="Top customers by credits">
          {!q.data ? <SkeletonRows /> : !q.data.top.length ? <Empty icon="coins" title="No usage yet" /> : (
            <table className="a-table"><thead><tr><th>Customer</th><th className="num">Credits</th><th className="num">Requests</th><th>Last used</th></tr></thead>
              <tbody>{q.data.top.map((t) => <tr key={t.tenantId} onClick={() => navigate(`/admin/customers/${t.tenantId}/usage`)}><td>{t.name}</td><td className="num">{fmtNum(t.credits)}</td><td className="num">{fmtNum(t.events)}</td><td>{fmtAgo(t.lastAt)}</td></tr>)}</tbody></table>
          )}
        </Card>
        <Card title="Staff credit adjustments" sub="From the ledger">
          {!q.data ? <SkeletonRows /> : !q.data.adjustments.length ? <Empty icon="coins" title="No adjustments yet" /> : (
            <table className="a-table"><thead><tr><th>When</th><th>Customer</th><th className="num">Credits</th><th>By / reason</th></tr></thead>
              <tbody>{q.data.adjustments.map((a, i) => <tr key={i} onClick={() => navigate(`/admin/customers/${a.tenantId}/subscription`)}><td>{fmtAgo(a.at)}</td><td>{a.customer}</td><td className="num" style={{ color: a.credits < 0 ? "#fca5a5" : "#86efac" }}>{a.credits > 0 ? "+" : ""}{fmtNum(a.credits)}</td><td>{a.actor?.replace(/^staff:/, "")}<small>{a.category ? `${a.category.replace(/_/g, " ")} · ` : ""}{a.reason}</small></td></tr>)}</tbody></table>
          )}
        </Card>
      </div>
    </>
  );
}

export function Invoices() {
  const [cursors, setCursors] = useState<string[]>([]);
  const after = cursors[cursors.length - 1];
  const q = useQuery<{ invoices: { id: string; number: string | null; accountId: string | null; customer: string | null; date: number; description: string; amountUsd: number; status: string; hostedUrl: string | null; pdfUrl: string | null }[]; hasMore: boolean; stripe: string }>(`/admin/invoices?limit=25${after ? `&startingAfter=${after}` : ""}`);
  return (
    <Card>
      <ErrorBox error={q.error} retry={q.reload} />
      {!q.data ? <SkeletonRows rows={8} /> : q.data.stripe === "not_configured" ? <Empty icon="invoice" title="Stripe isn't configured">Set STRIPE_SECRET_KEY to see invoices.</Empty> : !q.data.invoices.length ? <Empty icon="invoice" title="No invoices yet" /> : (
        <div className="a-table-wrap"><table className="a-table">
          <thead><tr><th>Invoice #</th><th>Customer</th><th>Date</th><th>Description</th><th className="num">Amount</th><th>Status</th><th /></tr></thead>
          <tbody>{q.data.invoices.map((i) => (
            <tr key={i.id} onClick={() => i.accountId && navigate(`/admin/customers/${i.accountId}/invoices`)}>
              <td style={{ color: "#a5b4fc" }}>{i.number ?? i.id}</td><td>{i.customer ?? <span className="muted">Unlinked</span>}</td><td>{fmtDate(i.date)}</td><td>{i.description}</td><td className="num">{fmtUsd(i.amountUsd)}</td>
              <td><span className={`a-badge ${i.status === "paid" ? "a-badge--active" : i.status === "open" ? "a-badge--past_due" : "a-badge--cancelled"}`}>{i.status}</span></td>
              <td onClick={(e) => e.stopPropagation()}>{i.hostedUrl ? <a href={i.hostedUrl} target="_blank" rel="noopener noreferrer" aria-label="Open invoice"><A.external size={15} /></a> : null}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <div className="a-pager" style={{ justifyContent: "flex-end" }}>
        <button disabled={!cursors.length} onClick={() => setCursors(cursors.slice(0, -1))}>Newer</button>
        <button disabled={!q.data?.hasMore} onClick={() => q.data && setCursors([...cursors, q.data.invoices[q.data.invoices.length - 1]!.id])}>Older</button>
      </div>
    </Card>
  );
}

export function Support() {
  const q = useQuery<{ notes: { id: string; tenantId: string; customer: string; authorEmail: string; body: string; createdAt: number }[]; paused: { tenantId: string; customer: string; reason: string; category: string; by: string; at: number }[]; actions: { id: string; at: number; actorEmail: string; title: string; customer: string | null; tenantId: string | null }[] }>("/admin/support");
  return (
    <>
      <ErrorBox error={q.error} retry={q.reload} />
      <div className="a-acct-row2" style={{ marginTop: 0 }}>
        <Card title="Paused accounts">
          {!q.data ? <SkeletonRows /> : !q.data.paused.length ? <Empty icon="pause" title="No paused accounts" /> : q.data.paused.map((p) => (
            <div key={p.tenantId} className="a-feed__row" style={{ cursor: "pointer" }} onClick={() => navigate(`/admin/customers/${p.tenantId}`)}><StatusBadge status="paused" /><span><b>{p.customer}</b><small className="muted" style={{ display: "block" }}>{p.category} · {p.reason} · {p.by}</small></span><time>{fmtAgo(p.at)}</time></div>
          ))}
        </Card>
        <Card title="Support notes" sub="Internal only">
          {!q.data ? <SkeletonRows /> : !q.data.notes.length ? <Empty icon="note" title="No support notes" /> : q.data.notes.map((n) => (
            <div key={n.id} className="a-feed__row" style={{ alignItems: "flex-start", cursor: "pointer" }} onClick={() => navigate(`/admin/customers/${n.tenantId}`)}><A.note size={16} /><span><b>{n.customer}</b><span style={{ display: "block", whiteSpace: "pre-wrap" }}>{n.body}</span><small className="muted">{n.authorEmail}</small></span><time>{fmtAgo(n.createdAt)}</time></div>
          ))}
        </Card>
      </div>
      <Card title="Support actions" className="" >
        {!q.data ? <SkeletonRows /> : !q.data.actions.length ? <Empty icon="support" title="No support actions yet" /> : (
          <table className="a-table"><thead><tr><th>When</th><th>Action</th><th>Customer</th><th>Staff</th></tr></thead>
            <tbody>{q.data.actions.map((a) => <tr key={a.id} onClick={() => a.tenantId && navigate(`/admin/customers/${a.tenantId}/audit`)}><td>{fmtAgo(a.at)}</td><td>{a.title}</td><td>{a.customer ?? "—"}</td><td>{a.actorEmail}</td></tr>)}</tbody></table>
        )}
      </Card>
    </>
  );
}
