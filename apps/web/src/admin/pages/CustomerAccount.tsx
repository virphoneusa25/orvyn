import { useState } from "react";
import { api } from "../../lib/api";
import { navigate } from "../../lib/router";
import { useQuery } from "../query";
import { fmtAgo, fmtCompact, fmtDate, fmtIn, fmtNum, fmtUsd, domainOf } from "../format";
import { A, type AIconName } from "../components/AIcons";
import { Bar, BarChart, Card, CopyId, Delta, Empty, ErrorBox, Skeleton, SkeletonRows, StatusBadge } from "../components/UI";
import { ActionModals, CustomerActionsMenu, EditProfileModal, PlanManager, type ActionKind } from "../components/CustomerActions";
import { canDo, useAdmin } from "../AdminApp";
import { ACT_ICON } from "./Dashboard";

interface Win { used: number; limit: number; resetAt: number }
export interface CustomerDetail {
  id: string; organizationId: string; name: string; kind: string; contact: { userId: string; email: string; name: string | null } | null; members: number; createdAt: number;
  plan: { id: string; label: string; priceMonthlyUsd: number | null }; complimentary: boolean; status: string; subscriptionStatus: string;
  creditsRemaining: number; monthlyAllowance: number; monthlyUsage: { used: number; limit: number }; renewalAt: number | null;
  tags: string[]; since: number; profile: { website: string | null; industry: string | null; location: string | null };
  members_?: never;
  wallet: { planId: string; included: number; purchased: number; reserved: number; available: number; windows: { fiveHour: Win; sevenDay: Win; cycle: Win }; cycleStart: number | null; cycleEnd: number | null; autoRecharge: unknown };
  usageCompare: { cycle: { now: number; before: number }; fiveHour: { now: number; before: number }; sevenDay: { now: number; before: number } };
  stripe: { customerId: string | null; subscriptionId: string | null; subscriptionStatus: string | null; cancelAtPeriodEnd: boolean; period: string | null };
  topupSpendUsd: number; suspension: { reason: string; category: string; by: string; at: number } | null;
  notes: { id: string; authorEmail: string; body: string; createdAt: number }[];
}
type Member = { userId: string; email: string; name: string | null; role: string; joinedAt: number; verified: boolean; lastSeenAt: number | null };

const TABS: [string, string, AIconName][] = [["overview", "Overview", "dashboard"], ["subscription", "Subscription", "sub"], ["usage", "Usage", "chart"], ["invoices", "Invoices", "invoice"], ["projects", "Projects", "folder"], ["workspaces", "Workspaces", "layers"], ["sandboxes", "Sandboxes", "shield"], ["audit", "Audit", "audit"]];

function change(now: number, before: number): number | null { if (!before) return now ? null : 0; return Math.round(((now - before) / before) * 1000) / 10; }

export function CustomerAccount({ id, tab }: { id: string; tab: string }) {
  const q = useQuery<{ customer: CustomerDetail & { team: Member[] } }>(`/admin/customers/${id}`, { staleMs: 10_000 });
  const c = q.data?.customer;
  if (q.error?.status === 404) return <Card><Empty icon="users" title="Customer not found">It may have been removed. <button className="a-link" onClick={() => navigate("/admin/customers")}>All customers</button></Empty></Card>;
  const renew = fmtIn(c?.renewalAt);
  return (
    <div data-testid="customer-account">
      <ErrorBox error={q.error} retry={q.reload} />
      <section className="a-card a-acct-head">
        {c ? <span className="a-acct-head__logo" style={{ background: "linear-gradient(135deg,#4f46e5,#7c3aed)" }}><A.bars3 size={30} /></span> : <Skeleton h={64} w={64} r={14} />}
        <div style={{ minWidth: 0 }}>
          {c ? <>
            <h2 data-testid="acct-name">{c.name} <StatusBadge status={c.status} /></h2>
            <div className="a-acct-head__sub">{domainOf(c.contact?.email, c.profile.website) || c.contact?.email} &nbsp;•&nbsp; {fmtNum(c.creditsRemaining)} credits remaining</div>
            <div className="a-acct-head__tags">
              {c.tags.map((t) => <span key={t} className={`a-tag${t === "High Usage" ? " a-tag--hot" : t === "Past Due" || t === "Paused" ? " a-tag--warn" : ""}`}>{t}</span>)}
              <span className="a-tag">Since {fmtDate(c.since)}</span>
            </div>
          </> : <><Skeleton h={26} w={260} /><Skeleton h={14} w={200} style={{ marginTop: 8 }} /></>}
        </div>
        <div className="a-acct-facts">
          <div><label>Plan</label><b>{c ? `${c.plan.label}${c.plan.id !== "free" && !c.plan.label.includes("Plan") ? " Plan" : ""}` : "…"}</b><small>{c?.complimentary ? "Complimentary" : c?.plan.priceMonthlyUsd ? `$${c.plan.priceMonthlyUsd}/month` : c?.plan.priceMonthlyUsd === null ? "Custom" : "Free"}</small></div>
          <div><label>Renewal Date</label><b>{c?.renewalAt ? fmtDate(c.renewalAt) : "—"}</b><small>{renew.text}</small></div>
          <div><label>Subscription Status</label><b>{c ? <StatusBadge status={c.status === "paused" ? statusFromSub(c.subscriptionStatus) : c.status} /> : "…"}</b><small>{c?.stripe.cancelAtPeriodEnd ? "Cancels at renewal" : c?.stripe.subscriptionId ? "Renews automatically" : c?.complimentary ? "Staff-assigned" : "No subscription"}</small></div>
          <div style={{ minWidth: 170 }}><label>Stripe Customer ID</label><b style={{ fontSize: 14 }}>{c ? <CopyId value={c.stripe.customerId} label="Stripe customer id" /> : "…"}</b><small>Created {fmtDate(c?.createdAt)}</small></div>
        </div>
        {c ? <CustomerActionsMenu c={c} /> : null}
      </section>
      {c?.suspension ? <div className="a-error" style={{ marginTop: 12 }} role="status"><A.pause size={18} /><span>Paused {fmtAgo(c.suspension.at)} by {c.suspension.by} · {c.suspension.category}: {c.suspension.reason}</span></div> : null}
      <nav className="a-pagetabs" aria-label="Customer sections">
        {TABS.map(([t, l, ic]) => { const Ic = A[ic]; return <button key={t} className={`a-pagetab${tab === t ? " is-on" : ""}`} aria-current={tab === t ? "page" : undefined} onClick={() => navigate(t === "overview" ? `/admin/customers/${id}` : `/admin/customers/${id}/${t}`)} data-testid={`tab-${t}`}><Ic /> {l}</button>; })}
      </nav>
      {!c ? <SkeletonRows rows={6} h={60} /> : tab === "overview" ? <Overview c={c} /> : tab === "subscription" ? <SubscriptionTab c={c} /> : tab === "usage" ? <UsageTab c={c} /> : tab === "invoices" ? <InvoicesTab id={id} full /> : tab === "projects" ? <ProjectsTab id={id} /> : tab === "workspaces" ? <WorkspacesTab id={id} /> : tab === "sandboxes" ? <SandboxesTab id={id} /> : tab === "audit" ? <AuditTab id={id} /> : <Empty icon="folder" title="Unknown section" />}
    </div>
  );
}

function statusFromSub(s: string): string { return s === "past_due" || s === "unpaid" ? "past_due" : s === "trialing" ? "trial" : s === "canceled" ? "cancelled" : "active"; }

function Overview({ c }: { c: CustomerDetail & { team: Member[] } }) {
  const [modal, setModal] = useState<ActionKind | null>(null);
  const [editing, setEditing] = useState(false);
  const me = useAdmin();
  const w = c.wallet.windows;
  const series = useQuery<{ series: { day: string; credits: number }[] }>(`/admin/customers/${c.id}/usage?days=30`);
  const hourly = series.data?.series.map((d) => d.credits) ?? [];
  return (
    <div className="a-acct-grid">
      <div style={{ minWidth: 0 }}>
        <div className="a-metrics5">
          <div className="a-card a-metric" data-testid="m-credits">
            <div className="a-metric__label">Credits Remaining</div>
            <div className="a-metric__value">{fmtNum(c.wallet.available)} <small>/ {fmtNum(Math.max(c.monthlyAllowance, c.wallet.available))}</small></div>
            <Bar value={c.wallet.available} max={Math.max(c.monthlyAllowance, c.wallet.available)} />
            <div className="a-metric__foot">{fmtNum(c.wallet.included)} included · {fmtNum(c.wallet.purchased)} top-up</div>
          </div>
          <Metric label="Monthly Usage" value={`${fmtNum(w.cycle.used)} credits`} delta={change(c.usageCompare.cycle.now, c.usageCompare.cycle.before)} foot={`vs ${fmtNum(c.usageCompare.cycle.before)} last cycle`} bars={hourly} />
          <Metric label="5 Hour Usage" value={`${fmtNum(w.fiveHour.used)} credits`} delta={change(c.usageCompare.fiveHour.now, c.usageCompare.fiveHour.before)} foot={`of ${fmtNum(w.fiveHour.limit)} · vs ${fmtNum(c.usageCompare.fiveHour.before)} previous 5h`} bars={hourly.slice(-10)} cyan />
          <Metric label="7 Day Usage" value={`${fmtNum(w.sevenDay.used)} credits`} delta={change(c.usageCompare.sevenDay.now, c.usageCompare.sevenDay.before)} foot={`of ${fmtNum(w.sevenDay.limit)} · vs ${fmtNum(c.usageCompare.sevenDay.before)} previous 7d`} bars={hourly.slice(-14)} />
          <div className="a-card a-metric">
            <div className="a-metric__label">Top-up Balance</div>
            <div className="a-metric__value"><A.coins size={18} /> {fmtNum(c.wallet.purchased)}</div>
            <div className="a-metric__foot">{c.wallet.purchased ? "Top-up credits never expire" : "No top-up credit"}</div>
            {canDo(me, "billing.write") ? <button className="btn btn--sm" style={{ marginTop: 10, borderColor: "rgba(99,102,241,.6)", color: "#a5b4fc" }} onClick={() => setModal("credits")} data-testid="add-topup">Add Top-up</button> : null}
          </div>
        </div>
        <div className="a-acct-row">
          <Card title="Customer Details" action={canDo(me, "support.write") ? <button className="btn btn--sm" style={{ marginLeft: "auto" }} onClick={() => setEditing(true)}>Edit Details</button> : null}>
            <dl className="a-kv2">
              <dt>Organization Name</dt><dd>{c.name}</dd>
              <dt>Website</dt><dd>{c.profile.website ? <a href={`https://${c.profile.website.replace(/^https?:\/\//, "")}`} target="_blank" rel="noopener noreferrer">{c.profile.website} <A.external size={12} /></a> : <span className="muted">Not set</span>}</dd>
              <dt>Primary Contact</dt><dd>{c.contact?.name ?? "—"}<br /><span className="muted">{c.contact?.email}</span></dd>
              <dt>Organization ID</dt><dd><CopyId value={c.organizationId} label="organization id" /></dd>
              <dt>Customer Since</dt><dd>{fmtDate(c.since)} <span className="muted">({monthsSince(c.since)})</span></dd>
              <dt>Account Type</dt><dd>{c.kind === "company" ? "Business" : "Personal"}</dd>
              <dt>Team Size</dt><dd>{c.members} member{c.members === 1 ? "" : "s"}</dd>
              <dt>Industry</dt><dd>{c.profile.industry ?? <span className="muted">Not set</span>}</dd>
              <dt>Location</dt><dd>{c.profile.location ?? <span className="muted">Not collected</span>}</dd>
              <dt>Payment Method</dt><dd><PaymentMethod id={c.id} /></dd>
              <dt>Total Spent</dt><dd><TotalSpent id={c.id} topups={c.topupSpendUsd} /></dd>
              <dt>Next Billing Date</dt><dd>{c.renewalAt ? <>{fmtDate(c.renewalAt)} <span style={{ color: fmtIn(c.renewalAt).soon ? "#f87171" : "var(--muted)" }}>({fmtIn(c.renewalAt).text})</span></> : "—"}</dd>
            </dl>
          </Card>
          <InvoicesTab id={c.id} />
          <Card title="Recent Projects & Workspaces" action={<button className="a-link" onClick={() => navigate(`/admin/customers/${c.id}/projects`)}>View All</button>}><ProjectsMini id={c.id} /></Card>
        </div>
        <div className="a-acct-row2">
          <ChatsCard id={c.id} />
          <UsageTrend id={c.id} />
        </div>
        {c.notes.length ? (
          <Card title="Support Notes" sub="Internal — never shown to the customer" className="" >
            {c.notes.map((n) => <div key={n.id} className="a-feed__row" style={{ alignItems: "flex-start" }}><A.note size={16} /><span style={{ whiteSpace: "pre-wrap" }}>{n.body}<br /><small className="muted">{n.authorEmail}</small></span><time>{fmtAgo(n.createdAt)}</time></div>)}
          </Card>
        ) : null}
      </div>
      <Card title="Account Activity"><Activity id={c.id} /><button className="btn btn--sm" style={{ width: "100%", marginTop: 6 }} onClick={() => navigate(`/admin/customers/${c.id}/audit`)}>View All Activity</button></Card>
      <ActionModals c={c} kind={modal} onClose={() => setModal(null)} />
      {editing ? <EditProfileModal c={c} profile={c.profile} onClose={() => setEditing(false)} /> : null}
    </div>
  );
}

function monthsSince(ts: number): string { const m = Math.max(0, Math.round((Date.now() - ts) / (30 * 86_400_000))); return m < 1 ? "new" : `${m} month${m === 1 ? "" : "s"}`; }

function Metric({ label, value, delta, foot, bars, cyan }: { label: string; value: string; delta: number | null; foot: string; bars: number[]; cyan?: boolean }) {
  const max = Math.max(1, ...bars);
  return (
    <div className="a-card a-metric">
      <div className="a-metric__label">{label}</div>
      <div className="a-metric__value">{value} <Delta value={delta} /></div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 30 }} aria-hidden="true">
        {bars.map((b, i) => <i key={i} style={{ flex: 1, height: `${Math.max(6, (b / max) * 100)}%`, borderRadius: 2, background: cyan ? "linear-gradient(180deg,#22d3ee,#3b82f6)" : "linear-gradient(180deg,#a855f7,#6366f1)", opacity: b ? 1 : 0.25 }} />)}
      </div>
      <div className="a-metric__foot">{foot}</div>
    </div>
  );
}

interface Invoices { invoices: { id: string; number: string | null; date: number; description: string; amountUsd: number; status: string; hostedUrl: string | null; pdfUrl: string | null }[]; stripe: string; hasMore?: boolean }

function InvoicesTab({ id, full }: { id: string; full?: boolean }) {
  const q = useQuery<Invoices>(`/admin/customers/${id}/invoices?limit=${full ? 50 : 5}`);
  const rows = q.data?.invoices ?? [];
  return (
    <Card title={full ? "Invoices" : "Recent Invoices"} action={!full ? <button className="a-link" onClick={() => navigate(`/admin/customers/${id}/invoices`)}>View All</button> : null}>
      <ErrorBox error={q.error} retry={q.reload} />
      {q.loading ? <SkeletonRows rows={4} h={26} /> : q.data?.stripe === "not_configured" ? <Empty icon="invoice" title="Stripe isn't configured">Invoices appear once payments are set up.</Empty> : !rows.length ? <Empty icon="invoice" title="No invoices yet" /> : (
        <table className="a-table" data-testid="acct-invoices">
          <thead><tr><th>Invoice #</th><th>Date</th><th className="num">Amount</th><th>Status</th><th /></tr></thead>
          <tbody>{rows.map((i) => (
            <tr key={i.id} onClick={() => i.hostedUrl && window.open(i.hostedUrl, "_blank", "noopener")}>
              <td style={{ color: "#a5b4fc" }}>{i.number ?? i.id.slice(0, 14)}{full ? <small>{i.description}</small> : null}</td><td>{fmtDate(i.date)}</td><td className="num">{fmtUsd(i.amountUsd)}</td>
              <td><span className={`a-badge ${i.status === "paid" ? "a-badge--active" : i.status === "open" ? "a-badge--past_due" : "a-badge--cancelled"}`}>{i.status === "paid" ? "Paid" : i.status}</span></td>
              <td>{i.hostedUrl ? <A.external size={15} /> : null}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </Card>
  );
}

function PaymentMethod({ id }: { id: string }) {
  const q = useQuery<{ subscription: unknown; customerId: string | null; stripe: string }>(`/admin/customers/${id}/subscription`);
  const pm = useQuery<{ paymentMethod: { brand: string; last4: string; expMonth: number; expYear: number } | null }>(`/admin/customers/${id}/payment-method`);
  if (q.data?.stripe === "not_configured") return <span className="muted">Stripe not configured</span>;
  const p = pm.data?.paymentMethod;
  return p ? <span>•••• {p.last4} <span className="muted">{p.brand} · Expires {String(p.expMonth).padStart(2, "0")}/{p.expYear}</span></span> : <span className="muted">{pm.loading ? "…" : "None on file"}</span>;
}

function TotalSpent({ id, topups }: { id: string; topups: number }) {
  const q = useQuery<Invoices>(`/admin/customers/${id}/invoices?limit=100`);
  if (!q.data) return <span className="muted">…</span>;
  const paid = q.data.invoices.filter((i) => i.status === "paid").reduce((a, i) => a + i.amountUsd, 0);
  return <span>{fmtUsd(q.data.stripe === "ok" ? paid : topups)}</span>;
}

function ProjectsMini({ id }: { id: string }) {
  const p = useQuery<{ projects: { id: string; name: string; type: string; createdAt: number }[] }>(`/admin/customers/${id}/projects`);
  const w = useQuery<{ workspaces: { id: string; name: string; createdAt: number }[] }>(`/admin/customers/${id}/workspaces`);
  if (!p.data || !w.data) return <SkeletonRows rows={4} h={24} />;
  const rows = [...p.data.projects.map((x) => ({ ...x, type: "Project" })), ...w.data.workspaces.map((x) => ({ ...x, type: "Workspace" }))].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
  if (!rows.length) return <Empty icon="folder" title="No projects yet" />;
  return (
    <table className="a-table">
      <thead><tr><th>Name</th><th>Type</th><th>Created</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.id} onClick={() => navigate(`/admin/customers/${id}/${r.type === "Project" ? "projects" : "workspaces"}`)}><td><span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><span style={{ color: "#a78bfa" }}><A.folder size={18} /></span>{r.name}</span></td><td>{r.type}</td><td>{fmtDate(r.createdAt)}</td></tr>)}</tbody>
    </table>
  );
}

function ChatsCard({ id }: { id: string }) {
  const q = useQuery<{ chats: { id: string; title: string; project: string | null; kind: string; credits: number; updatedAt: number }[] }>(`/admin/customers/${id}/chats?limit=8`);
  return (
    <Card title="Recent Chats / Missions" action={<button className="a-link" onClick={() => navigate(`/admin/customers/${id}/usage`)}>View All</button>}>
      {!q.data ? <SkeletonRows rows={5} h={24} /> : !q.data.chats.length ? <Empty icon="chat" title="No chats yet" /> : (
        <table className="a-table">
          <thead><tr><th>Title</th><th>Project / Workspace</th><th className="num">Credits</th><th>Date</th></tr></thead>
          <tbody>{q.data.chats.map((ch) => <tr key={ch.id} style={{ cursor: "default" }}><td><span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>{ch.kind === "mission" ? <A.layers size={15} /> : <A.chat size={15} />}{ch.title}</span></td><td>{ch.project ?? <span className="muted">Cloud Chat</span>}</td><td className="num">{fmtNum(ch.credits)}</td><td>{fmtAgo(ch.updatedAt)}</td></tr>)}</tbody>
        </table>
      )}
      <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>Titles only — staff can't read conversation content here.</p>
    </Card>
  );
}

const METRICS: [string, string][] = [["credits", "Credits Used"], ["tokens", "Tokens"], ["costUsd", "Cost"], ["missions", "Missions"], ["chat", "Cloud Chat"]];

function UsageTrend({ id, days = 30 }: { id: string; days?: number }) {
  const me = useAdmin();
  const [metric, setMetric] = useState("credits");
  const [range, setRange] = useState(days);
  const q = useQuery<{ series: Record<string, number | string | null>[] }>(`/admin/customers/${id}/usage?days=${range}`);
  const metrics = METRICS.filter(([k]) => k !== "costUsd" || canDo(me, "costs.read"));
  return (
    <Card title={`Usage Trend (Last ${range} Days)`} action={<span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
      <select className="input select" aria-label="Metric" value={metric} onChange={(e) => setMetric(e.target.value)} style={{ height: 32, fontSize: 13 }} data-testid="usage-metric">{metrics.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      <select className="input select" aria-label="Period" value={range} onChange={(e) => setRange(Number(e.target.value))} style={{ height: 32, fontSize: 13 }}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select>
    </span>}>
      {!q.data ? <Skeleton h={150} /> : <BarChart points={q.data.series.map((d) => ({ day: String(d.day), value: Number(d[metric] ?? 0) }))} label={`${metric} per day`} format={metric === "costUsd" ? (n) => `$${n.toFixed(n < 10 ? 2 : 0)}` : fmtCompact} />}
    </Card>
  );
}

function Activity({ id, limit = 8 }: { id: string; limit?: number }) {
  const q = useQuery<{ activity: { at: number; kind: string; title: string; detail: string }[] }>(`/admin/customers/${id}/activity?limit=${limit}`);
  if (!q.data) return <SkeletonRows rows={5} h={40} />;
  if (!q.data.activity.length) return <Empty icon="clock" title="No activity yet" />;
  return (
    <div className="a-timeline" data-testid="acct-activity">
      {q.data.activity.map((a, i) => {
        const Ic = A[ACT_ICON[a.kind] ?? "clock"] ?? A.clock;
        return <div key={i} className="a-tl"><span className={`a-tl__ic a-tl__ic--${a.kind}`}><Ic /></span><div style={{ minWidth: 0 }}><b>{a.title}</b><span className="sub">{a.detail}</span><time>{fmtAgo(a.at)}</time></div></div>;
      })}
    </div>
  );
}

function SubscriptionTab({ c }: { c: CustomerDetail }) {
  const me = useAdmin();
  const [managing, setManaging] = useState(false);
  const q = useQuery<{ plan: { label: string }; walletStatus: string; cycleStart: number | null; cycleEnd: number | null; customerId: string | null; stripe: string; subscription: null | { id: string; status: string; cancelAtPeriodEnd: boolean; currentPeriodStart: number | null; currentPeriodEnd: number | null; priceId: string; period: string; scheduleId: string | null } }>(`/admin/customers/${c.id}/subscription`, { staleMs: 5_000 });
  const s = q.data?.subscription;
  return (
    <div className="a-acct-row2" style={{ marginTop: 0 }}>
      <Card title="Subscription" sub={q.data?.stripe === "ok" ? "Live from Stripe" : ""} action={canDo(me, "billing.write") ? <button className="btn btn--primary btn--sm" style={{ marginLeft: "auto" }} onClick={() => setManaging(true)} data-testid="manage-plan">Manage Plan</button> : null}>
        <ErrorBox error={q.error} retry={q.reload} />
        {!q.data ? <SkeletonRows rows={5} h={22} /> : (
          <dl className="a-kv2">
            <dt>Plan</dt><dd><b>{c.plan.label}</b>{c.complimentary ? " · complimentary" : ""}</dd>
            <dt>Wallet status</dt><dd>{q.data.walletStatus}</dd>
            <dt>Current cycle</dt><dd>{fmtDate(q.data.cycleStart)} → {fmtDate(q.data.cycleEnd)}</dd>
            <dt>Stripe customer</dt><dd><CopyId value={q.data.customerId} /></dd>
            <dt>Stripe subscription</dt><dd>{q.data.stripe === "not_configured" ? "Stripe isn't configured" : q.data.stripe === "unavailable" ? "Stripe unavailable — retry" : s ? <CopyId value={s.id} /> : "None"}</dd>
            {s ? <><dt>Stripe status</dt><dd><StatusBadge status={statusFromSub(s.status)} /> {s.cancelAtPeriodEnd ? <span className="a-tag a-tag--warn">Cancels at renewal</span> : null} {s.scheduleId ? <span className="a-tag">Change scheduled</span> : null}</dd>
              <dt>Billing cycle</dt><dd style={{ textTransform: "capitalize" }}>{s.period}</dd>
              <dt>Period</dt><dd>{fmtDate(s.currentPeriodStart)} → {fmtDate(s.currentPeriodEnd)}</dd>
              <dt>Price</dt><dd className="a-mono">{s.priceId}</dd></> : null}
          </dl>
        )}
      </Card>
      <Card title="Ledger" sub="Append-only; balances are the sum of entries"><Ledger id={c.id} /></Card>
      {managing ? <PlanManager c={c} onClose={() => { setManaging(false); q.reload(); }} /> : null}
    </div>
  );
}

function Ledger({ id }: { id: string }) {
  const q = useQuery<{ entries: { id: string; type: string; bucket: string; amount: number; actor: string | null; meta: Record<string, unknown>; createdAt: number }[]; verify: { ok: boolean } }>(`/admin/customers/${id}/ledger?limit=100`);
  if (!q.data) return <SkeletonRows rows={6} h={22} />;
  const rows = q.data.entries.filter((e) => e.type !== "mission_reservation" && e.type !== "reservation_release");
  if (!rows.length) return <Empty icon="coins" title="No ledger entries yet" />;
  return (
    <div style={{ maxHeight: 420, overflow: "auto" }}>
      <table className="a-table" data-testid="ledger">
        <thead><tr><th>Date</th><th>Type</th><th>Bucket</th><th className="num">Credits</th><th>By / reason</th></tr></thead>
        <tbody>{rows.map((e) => <tr key={e.id} style={{ cursor: "default" }}><td>{fmtDate(e.createdAt)}</td><td>{e.type.replace(/_/g, " ")}</td><td>{e.bucket}</td><td className="num" style={{ color: e.amount < 0 ? "#fca5a5" : "#86efac" }}>{e.amount > 0 ? "+" : ""}{fmtNum(e.amount)}</td><td>{e.actor ?? ""}<small>{String(e.meta?.reason ?? "")}</small></td></tr>)}</tbody>
      </table>
    </div>
  );
}

function UsageTab({ c }: { c: CustomerDetail }) {
  const w = c.wallet.windows;
  const q = useQuery<{ chats: { id: string; title: string; project: string | null; kind: string; credits: number; updatedAt: number }[] }>(`/admin/customers/${c.id}/chats?limit=100`);
  return (
    <>
      <div className="a-grid4" style={{ gridTemplateColumns: "repeat(3, minmax(0,1fr))" }}>
        {([["Monthly credits", w.cycle], ["5-hour window", w.fiveHour], ["7-day window", w.sevenDay]] as const).map(([l, x]) => (
          <div key={l} className="a-card a-metric"><div className="a-metric__label">{l}</div><div className="a-metric__value">{fmtNum(x.used)} <small>/ {fmtNum(x.limit)}</small></div><Bar value={x.used} max={x.limit} tone="auto" /><div className="a-metric__foot">Resets {fmtDate(x.resetAt)}</div></div>
        ))}
      </div>
      <div className="a-acct-row2"><UsageTrend id={c.id} /><Card title="Balance">
        <dl className="a-kv2"><dt>Available</dt><dd>{fmtNum(c.wallet.available)}</dd><dt>Included (this cycle)</dt><dd>{fmtNum(c.wallet.included)}</dd><dt>Top-up</dt><dd>{fmtNum(c.wallet.purchased)}</dd><dt>Held by running work</dt><dd>{fmtNum(c.wallet.reserved)}</dd></dl>
      </Card></div>
      <Card title="Chats & missions by credits" className="" >
        {!q.data ? <SkeletonRows rows={6} h={22} /> : !q.data.chats.length ? <Empty icon="chat" title="No chats or missions yet" /> : (
          <table className="a-table"><thead><tr><th>Title</th><th>Kind</th><th>Project</th><th className="num">Credits</th><th>Last active</th></tr></thead>
            <tbody>{[...q.data.chats].sort((a, b) => b.credits - a.credits).map((ch) => <tr key={ch.id} style={{ cursor: "default" }}><td>{ch.title}</td><td>{ch.kind === "mission" ? "Mission" : "Chat"}</td><td>{ch.project ?? "—"}</td><td className="num">{fmtNum(ch.credits)}</td><td>{fmtAgo(ch.updatedAt)}</td></tr>)}</tbody></table>
        )}
      </Card>
    </>
  );
}

function ProjectsTab({ id }: { id: string }) {
  const q = useQuery<{ projects: { id: string; name: string; type: string; createdAt: number; owner: string | null }[] }>(`/admin/customers/${id}/projects`);
  return (
    <Card title="Projects" sub="Read-only">
      {!q.data ? <SkeletonRows rows={5} /> : !q.data.projects.length ? <Empty icon="folder" title="No projects yet" /> : (
        <table className="a-table" data-testid="acct-projects"><thead><tr><th>Name</th><th>Type</th><th>Owner</th><th>Created</th><th>ID</th></tr></thead>
          <tbody>{q.data.projects.map((p) => <tr key={p.id} style={{ cursor: "default" }}><td>{p.name}</td><td>{p.type}</td><td>{p.owner ?? "—"}</td><td>{fmtDate(p.createdAt)}</td><td><CopyId value={p.id} /></td></tr>)}</tbody></table>
      )}
    </Card>
  );
}

function WorkspacesTab({ id }: { id: string }) {
  const q = useQuery<{ workspaces: { id: string; name: string; projectId: string; createdAt: number }[] }>(`/admin/customers/${id}/workspaces`);
  return (
    <Card title="Workspaces" sub="Desktop project folders bound to this account (read-only)">
      {!q.data ? <SkeletonRows rows={5} /> : !q.data.workspaces.length ? <Empty icon="layers" title="No workspaces yet">Workspaces appear when the customer runs Desktop missions in a folder.</Empty> : (
        <table className="a-table"><thead><tr><th>Name</th><th>Project</th><th>Created</th><th>ID</th></tr></thead>
          <tbody>{q.data.workspaces.map((w) => <tr key={w.id} style={{ cursor: "default" }}><td>{w.name}</td><td className="a-mono">{w.projectId}</td><td>{fmtDate(w.createdAt)}</td><td><CopyId value={w.id} /></td></tr>)}</tbody></table>
      )}
    </Card>
  );
}

interface SandboxRow { id: string; provider: string; state: string; policyTemplate: string; policyVersion: number; retention: string; runId: string | null; projectId: string | null; provisionMs: number | null; reconnects: number; execCount: number; policyDenials: number; fallbackReason: string | null; lastError: string | null; createdAt: number; updatedAt: number }
interface SandboxData { runtimeFlag: boolean | null; organizationId: string; sandboxes: SandboxRow[]; requests: { id: string; template: string; status: string; reason: string; params: Record<string, string[]>; createdAt: number; decidedBy: string | null }[]; audit: { id: string; type: string; actor: string; detail: Record<string, unknown>; at: number }[] }

/** Execution sandboxes for this customer: provider, state, policy, failures. Opening this tab is audited. */
function SandboxesTab({ id }: { id: string }) {
  const me = useAdmin();
  const q = useQuery<SandboxData>(`/admin/customers/${id}/sandboxes`);
  const [busy, setBusy] = useState(false);
  const setFlag = async (enabled: boolean | null) => {
    if (!q.data) return;
    setBusy(true);
    try { await api(`/admin/runtime/flags`, { method: "PUT", body: { scope: "org", scopeId: q.data.organizationId, enabled } }); q.reload(); } finally { setBusy(false); }
  };
  const decide = async (rid: string, approve: boolean) => { await api(`/admin/runtime/requests/${rid}`, { method: "POST", body: { approve } }); q.reload(); };
  const d = q.data;
  return (
    <>
      <ErrorBox error={q.error} retry={q.reload} />
      <Card title="Execution runtime" sub="Which sandbox runs this customer's cloud missions (internal)" action={canDo(me, "staff.manage") && d ? (
        <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button className={`btn btn--sm${d.runtimeFlag === true ? " btn--primary" : ""}`} disabled={busy} onClick={() => void setFlag(true)} data-testid="openshell-on">OpenShell canary on</button>
          <button className={`btn btn--sm${d.runtimeFlag === false ? " btn--primary" : ""}`} disabled={busy} onClick={() => void setFlag(false)}>Force Docker</button>
        </span>
      ) : null}>
        {!d ? <SkeletonRows rows={2} /> : <p className="muted" style={{ margin: 0 }}>Flag <span className="a-mono">openshell_runtime</span>: <b>{d.runtimeFlag === null ? "not set (deployment default)" : d.runtimeFlag ? "on" : "off"}</b>. The deployment must also have OpenShell enabled; otherwise missions stay on Docker.</p>}
      </Card>
      <Card title="Sandboxes" sub="Latest 50">
        {!d ? <SkeletonRows rows={5} /> : !d.sandboxes.length ? <Empty icon="shield" title="No cloud sandboxes yet">They appear when this customer runs a mission in ORVYN Cloud.</Empty> : (
          <div className="a-table-wrap"><table className="a-table" data-testid="sandbox-table">
            <thead><tr><th>Sandbox</th><th>Provider</th><th>State</th><th>Policy</th><th>Retention</th><th className="num">Provision</th><th className="num">Commands</th><th className="num">Denials</th><th>Notes</th><th>Updated</th></tr></thead>
            <tbody>{d.sandboxes.map((s) => (
              <tr key={s.id} style={{ cursor: "default" }}>
                <td><CopyId value={s.id} /></td><td>{s.provider}</td><td style={{ textTransform: "capitalize" }}>{s.state}</td>
                <td className="a-mono">{s.policyTemplate}.v{s.policyVersion}</td><td>{s.retention}</td>
                <td className="num">{s.provisionMs === null ? "—" : `${s.provisionMs} ms`}</td><td className="num">{fmtNum(s.execCount)}</td><td className="num">{fmtNum(s.policyDenials)}</td>
                <td className="muted" style={{ maxWidth: 260 }}>{[s.fallbackReason && `fell back: ${s.fallbackReason}`, s.reconnects ? `${s.reconnects} reconnects` : "", s.lastError].filter(Boolean).join(" · ") || "—"}</td>
                <td>{fmtAgo(s.updatedAt)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <div className="a-acct-row2">
        <Card title="Network access requests">
          {!d ? <SkeletonRows rows={3} /> : !d.requests.length ? <Empty icon="shield" title="No requests" /> : (
            <table className="a-table"><thead><tr><th>Access</th><th>Reason</th><th>Status</th><th /></tr></thead>
              <tbody>{d.requests.map((r) => <tr key={r.id} style={{ cursor: "default" }}><td className="a-mono">{r.template}{r.params.host?.length ? ` (${r.params.host.join(", ")})` : ""}</td><td className="muted">{r.reason || "—"}</td><td>{r.status}{r.decidedBy ? <span className="muted"> · {r.decidedBy}</span> : null}</td>
                <td>{r.status === "pending" && canDo(me, "support.write") ? <span style={{ display: "flex", gap: 6 }}><button className="btn btn--sm btn--primary" onClick={() => void decide(r.id, true)}>Approve</button><button className="btn btn--sm" onClick={() => void decide(r.id, false)}>Deny</button></span> : null}</td></tr>)}</tbody></table>
          )}
        </Card>
        <Card title="Sandbox audit" sub="Credential attachment, policy changes, denials, staff access">
          {!d ? <SkeletonRows rows={4} /> : !d.audit.length ? <Empty icon="audit" title="Nothing recorded" /> : (
            <table className="a-table"><tbody>{d.audit.map((a) => <tr key={a.id} style={{ cursor: "default" }}><td className="a-mono">{a.type}</td><td className="muted">{a.actor}</td><td className="muted" style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{JSON.stringify(a.detail)}</td><td>{fmtAgo(a.at)}</td></tr>)}</tbody></table>
          )}
        </Card>
      </div>
    </>
  );
}

function AuditTab({ id }: { id: string }) {
  const [before, setBefore] = useState<number[]>([]);
  const cursor = before[before.length - 1];
  const q = useQuery<{ audit: { id: string; at: number; actorEmail: string; action: string; detail: Record<string, unknown>; ip: string | null }[]; titles: Record<string, string> }>(`/admin/customers/${id}/audit?limit=50${cursor ? `&before=${cursor}` : ""}`);
  return (
    <div className="a-acct-row2" style={{ marginTop: 0 }}>
      <Card title="Staff audit log" sub="Every staff action on this account">
        {!q.data ? <SkeletonRows rows={6} /> : !q.data.audit.length ? <Empty icon="audit" title="No staff actions yet" /> : (
          <table className="a-table" data-testid="acct-audit"><thead><tr><th>When</th><th>Action</th><th>Staff</th><th>Details</th></tr></thead>
            <tbody>{q.data.audit.map((a) => <tr key={a.id} style={{ cursor: "default" }}><td>{fmtDate(a.at)}<small>{new Date(a.at).toLocaleTimeString()}</small></td><td>{q.data!.titles[a.action] ?? a.action}</td><td>{a.actorEmail}</td><td style={{ maxWidth: 320, whiteSpace: "normal" }}><small>{Object.entries(a.detail).filter(([k]) => !["entries"].includes(k)).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ")}</small></td></tr>)}</tbody></table>
        )}
        <div className="a-pager" style={{ justifyContent: "flex-end" }}>
          <button disabled={!before.length} onClick={() => setBefore(before.slice(0, -1))}>Newer</button>
          <button disabled={!q.data || q.data.audit.length < 50} onClick={() => setBefore([...before, q.data!.audit[q.data!.audit.length - 1]!.at])}>Older</button>
        </div>
      </Card>
      <Card title="Account activity"><Activity id={id} limit={40} /></Card>
    </div>
  );
}

