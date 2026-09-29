import { useEffect, useState } from "react";
import { navigate } from "../../lib/router";
import { useQuery } from "../query";
import { fmtAgo, fmtCompact, fmtDate, fmtIn, fmtNum, fmtUsd, fmtUsd0 } from "../format";
import { A } from "../components/AIcons";
import { BarChart, Card, CopyId, Delta, Donut, DONUT_COLORS, Empty, ErrorBox, OrgLogo, Skeleton, Sparkline, StatusBadge, Bar } from "../components/UI";
import { CustomerTable, type CustomerRow } from "../components/CustomerTable";
import { ActionModals, CustomerActionsMenu, type ActionKind } from "../components/CustomerActions";
import { canDo, useAdmin } from "../AdminApp";

export interface DashboardData {
  totalUsers: { value: number; new30d: number; change: number | null };
  paidCustomers: { value: number; conversion: number; new30d: number };
  mrr: { value: number; arr: number };
  creditsUsed: { value: number; change: number | null };
  subscriptions: { total: number; active: number; pastDue: number; cancelled: number; pct: { active: number; pastDue: number; cancelled: number } };
  revenueByPlan: { plan: string; label: string; customers: number; mrr: number; share: number }[];
  creditTrend: { day: string; credits: number }[];
  signups: { total30d: number; change: number | null; days: { day: string; count: number }[] };
  providerCosts: { totalUsd: number; byClass: { name: string; usd: number; share: number }[] } | null;
  activity: { at: number; kind: string; title: string; detail: string; tenantId?: string | null; customer?: string | null }[];
}

export const ACT_ICON: Record<string, keyof typeof A> = { usage: "coins", project: "folder", payment: "dollar", invoice: "receipt", plan: "sub", team: "users", support: "support", adjustment: "coins", refund: "refund" as never };

function cumulative(xs: number[]): number[] { let s = 0; return xs.map((x) => (s += x)); }

export function Dashboard() {
  const d = useQuery<DashboardData>("/admin/dashboard", { refreshMs: 120_000 });
  const health = useQuery<{ status: string; checks: { id: string; name: string; status: string; detail: string; latencyMs?: number }[] }>("/admin/health", { refreshMs: 60_000 });
  const [sel, setSel] = useState<CustomerRow | null>(null);
  const data = d.data;
  return (
    <div data-testid="admin-dashboard">
      <ErrorBox error={d.error} retry={d.reload} />
      <div style={{ position: "relative" }}>
        <span className="a-range"><span className="a-tag"><A.calendar size={14} />&nbsp; Last 30 days</span></span>
        <div className="a-grid4">
          <Kpi icon="users" label="Total Users" value={data ? fmtNum(data.totalUsers.value) : null} delta={data?.totalUsers.change} sub={data ? `+${fmtNum(data.totalUsers.new30d)} this month` : ""} spark={data ? cumulative(data.signups.days.map((x) => x.count)) : []} testid="kpi-users" />
          <Kpi icon="shield" label="Paid Customers" value={data ? fmtNum(data.paidCustomers.value) : null} sub={data ? `${data.paidCustomers.conversion}% conversion · +${fmtNum(data.paidCustomers.new30d)} new` : ""} spark={[]} testid="kpi-paid" />
          <Kpi icon="dollar" cyan label="Monthly Recurring Revenue" value={data ? fmtUsd0(data.mrr.value) : null} sub={data ? `${fmtUsd0(data.mrr.arr)} ARR` : ""} spark={[]} testid="kpi-mrr" />
          <Kpi icon="bars3" label="Total Credits Used" value={data ? fmtCompact(data.creditsUsed.value) : null} delta={data?.creditsUsed.change} sub="Across all customers" spark={data ? data.creditTrend.map((x) => x.credits) : []} testid="kpi-credits" />
        </div>
      </div>

      <div className="a-grid-dash2">
        <Card title="Active Subscriptions">
          {data ? (
            <>
              <div className="a-kpi__value" style={{ fontSize: 26 }}>{fmtNum(data.subscriptions.active)}</div>
              <Bar value={data.subscriptions.active} max={Math.max(1, data.subscriptions.total)} tone="violet" />
              <div className="a-legend" style={{ marginTop: 14 }}>
                <div className="a-legend__row"><i style={{ background: "#3b82f6" }} /><span>Active</span><span>{fmtNum(data.subscriptions.active)}</span><span>{data.subscriptions.pct.active}%</span></div>
                <div className="a-legend__row"><i style={{ background: "#f59e0b" }} /><span>Past Due</span><span>{fmtNum(data.subscriptions.pastDue)}</span><span>{data.subscriptions.pct.pastDue}%</span></div>
                <div className="a-legend__row"><i style={{ background: "#f43f5e" }} /><span>Cancelled</span><span>{fmtNum(data.subscriptions.cancelled)}</span><span>{data.subscriptions.pct.cancelled}%</span></div>
              </div>
            </>
          ) : <Skeleton h={120} />}
        </Card>
        <Card title="Revenue by Plan">
          {data ? data.revenueByPlan.length ? (
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <Donut parts={data.revenueByPlan.map((r) => ({ label: r.label, value: r.mrr }))} center={fmtUsd0(data.mrr.value).replace(/(\d),(\d{3})$/, "$1.$2K").replace(/\.(\d)\d\dK$/, ".$1K")} sub="MRR" />
              <div className="a-legend" style={{ flex: 1 }}>
                {data.revenueByPlan.map((r, i) => <div key={r.plan} className="a-legend__row" style={{ gridTemplateColumns: "12px 1fr auto" }}><i style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} /><span>{r.label}</span><span>{r.share}%</span></div>)}
              </div>
            </div>
          ) : <Empty icon="dollar" title="No paid subscriptions yet" /> : <Skeleton h={140} />}
        </Card>
        <Card title="Credit Usage Trend" action={data ? <span style={{ marginLeft: "auto", color: "#c4b5fd", fontWeight: 700 }}>{fmtCompact(data.creditsUsed.value)} <Delta value={data.creditsUsed.change} /></span> : null}>
          {data ? <BarChart points={data.creditTrend.map((x) => ({ day: x.day, value: x.credits }))} label="Credits used per day, last 30 days" /> : <Skeleton h={140} />}
        </Card>
        <Card title="New Signups" action={data ? <span style={{ marginLeft: "auto" }}><Delta value={data.signups.change} /></span> : null}>
          {data ? <><div className="a-kpi__value" style={{ fontSize: 24, marginTop: -6 }}>{fmtNum(data.signups.total30d)}</div><BarChart points={data.signups.days.map((x) => ({ day: x.day, value: x.count }))} label="Sign-ups per day, last 30 days" height={120} format={(n) => String(Math.round(n))} /></> : <Skeleton h={140} />}
        </Card>
      </div>

      <div className="a-grid-main">
        <Card><CustomerTable pageSize={8} selected={sel?.id ?? null} onSelect={setSel} /></Card>
        <div className="grid" style={{ gap: 14 }}>
          <SelectedCustomer row={sel} />
          <Card title="Recent Activity" action={<button className="a-link" onClick={() => navigate("/admin/audit")}>View All</button>}>
            {data ? data.activity.length ? data.activity.map((a, i) => {
              const Ic = A[ACT_ICON[a.kind] ?? "clock"] ?? A.clock;
              return (
                <div key={i} className="a-feed__row" style={{ cursor: a.tenantId ? "pointer" : undefined }} onClick={() => a.tenantId && navigate(`/admin/customers/${a.tenantId}`)}>
                  <span className={`a-tl__ic a-tl__ic--${a.kind}`} style={{ width: 26, height: 26 }}><Ic size={14} /></span>
                  <span style={{ minWidth: 0 }}>{a.title}{a.customer ? <span className="muted"> · {a.customer}</span> : null}</span>
                  <time>{fmtAgo(a.at)}</time>
                </div>
              );
            }) : <Empty icon="clock" title="No activity yet" /> : <Skeleton h={160} />}
          </Card>
        </div>
      </div>

      <div className="a-grid3">
        <Card title="System Health" action={<><span className="a-badge a-badge--active a-badge--plain" style={{ marginLeft: 6, visibility: health.data?.status === "operational" ? "visible" : "hidden" }}>All Systems Operational</span><button className="a-link" onClick={() => navigate("/admin/health")}>View Details</button></>}>
          {health.data ? (
            <div className="a-health">
              {health.data.checks.map((c) => (
                <div key={c.id} className="a-health__row" title={c.detail}>
                  <i className={`adm-dot adm-dot--${c.status}`} style={{ width: 8, height: 8 }} />
                  <span>{c.name}</span>
                  <em>{c.status === "operational" ? (c.latencyMs !== undefined ? `${c.latencyMs} ms` : "OK") : c.status === "not_configured" ? "n/a" : c.status}</em>
                </div>
              ))}
            </div>
          ) : <Skeleton h={100} />}
        </Card>
        <ProviderCostsCard data={data} />
        <Card title="Top Plans by Revenue" sub="MRR">
          {data ? data.revenueByPlan.length ? data.revenueByPlan.map((r, i) => (
            <div key={r.plan} style={{ display: "grid", gridTemplateColumns: "12px 80px 90px 1fr 50px", gap: 8, alignItems: "center", fontSize: 13, marginBottom: 8 }}>
              <i style={{ width: 10, height: 10, borderRadius: "50%", background: DONUT_COLORS[i % DONUT_COLORS.length] }} />
              <span>{r.label}</span><span>{fmtUsd(r.mrr, 0)}</span>
              <Bar value={r.mrr} max={data.revenueByPlan[0]!.mrr} tone="violet" />
              <span className="muted" style={{ textAlign: "right" }}>{r.share}%</span>
            </div>
          )) : <Empty icon="tag" title="No revenue yet" /> : <Skeleton h={120} />}
        </Card>
      </div>
    </div>
  );
}

function Kpi({ icon, label, value, delta, sub, spark, cyan, testid }: { icon: keyof typeof A; label: string; value: string | null; delta?: number | null; sub: string; spark: number[]; cyan?: boolean; testid?: string }) {
  const Ic = A[icon];
  return (
    <div className="a-card a-kpi" data-testid={testid}>
      <span className={`a-kpi__icon${cyan ? " a-kpi__icon--cyan" : ""}`}><Ic size={24} /></span>
      <div className="a-kpi__body">
        <div className="a-kpi__label">{label}</div>
        {value === null ? <Skeleton h={30} w={120} /> : <div className="a-kpi__value">{value}{delta !== undefined ? <Delta value={delta} /> : null}</div>}
        <div className="a-kpi__sub">{sub}</div>
      </div>
      <Sparkline values={spark} color={cyan ? "#22d3ee" : "#a78bfa"} />
    </div>
  );
}

function ProviderCostsCard({ data }: { data: DashboardData | null }) {
  const me = useAdmin();
  if (!canDo(me, "costs.read")) return <Card title="Provider Costs (Internal)"><Empty icon="shield" title="Restricted">Your role can't see internal costs.</Empty></Card>;
  const pc = data?.providerCosts;
  const max = Math.max(1, ...(pc?.byClass.map((c) => c.usd) ?? [1]));
  return (
    <Card title="Provider Costs (Internal)" sub="Last 30 days" action={<button className="a-link" onClick={() => navigate("/admin/provider-costs")}>Details</button>}>
      {pc ? (
        <div style={{ display: "flex", gap: 14, alignItems: "flex-end" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", height: 110, flex: 1 }}>
            {pc.byClass.length ? pc.byClass.map((c, i) => <div key={c.name} title={`${c.name}: ${fmtUsd(c.usd)}`} style={{ flex: 1, height: `${Math.max(4, (c.usd / max) * 100)}%`, borderRadius: 4, background: `linear-gradient(180deg, ${DONUT_COLORS[i % DONUT_COLORS.length]}, rgba(99,102,241,.35))` }} />) : <Empty icon="dollar" title="No usage yet" />}
          </div>
          <div style={{ minWidth: 150 }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: "#e9d5ff", textAlign: "right" }}>{fmtUsd(pc.totalUsd)}</div>
            <div className="a-legend" style={{ marginTop: 6 }}>
              {pc.byClass.map((c, i) => <div key={c.name} className="a-legend__row" style={{ gridTemplateColumns: "12px 1fr auto" }}><i style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} /><span style={{ fontSize: 12 }}>{c.name}</span><span style={{ fontSize: 12 }}>{c.share}%</span></div>)}
            </div>
          </div>
        </div>
      ) : <Skeleton h={120} />}
    </Card>
  );
}

interface Detail { customer: CustomerRow & { stripe: { customerId: string | null; subscriptionId: string | null }; since: number; wallet: { available: number; windows: { cycle: { used: number; limit: number } } } } }

/** The right-hand Customer Details panel on the dashboard (the selected row). */
function SelectedCustomer({ row }: { row: CustomerRow | null }) {
  const q = useQuery<Detail>(row ? `/admin/customers/${row.id}` : null);
  const [tab, setTab] = useState("overview");
  const [modal, setModal] = useState<ActionKind | null>(null);
  useEffect(() => setTab("overview"), [row?.id]);
  if (!row) return <Card title="Customer Details"><Empty icon="userSearch" title="Select a customer">Pick a row to see their account here.</Empty></Card>;
  const c = q.data?.customer;
  const pct = row.monthlyUsage.limit ? Math.round((row.monthlyUsage.used / row.monthlyUsage.limit) * 100) : 0;
  const renew = fmtIn(row.renewalAt);
  return (
    <Card title="Customer Details" action={c?.stripe.customerId ? <a className="a-link" href={`https://dashboard.stripe.com/customers/${c.stripe.customerId}`} target="_blank" rel="noopener noreferrer" style={{ marginLeft: "auto" }}>View in Stripe</a> : null}>
      <div data-testid="selected-customer">
        <div className="a-detail__org">
          <OrgLogo name={row.name} seed={row.id} />
          <div style={{ minWidth: 0, flex: 1 }}><b style={{ fontSize: 16 }}>{row.name}</b><div className="muted" style={{ fontSize: 12.5 }}>{row.contact?.email.split("@")[1] ?? ""}</div></div>
          <div style={{ textAlign: "right" }}><StatusBadge status={row.status} /><div style={{ fontSize: 13, marginTop: 4 }}>{row.plan.label}</div><div className="muted" style={{ fontSize: 12 }}>{row.plan.priceMonthlyUsd ? `$${row.plan.priceMonthlyUsd}/month` : ""}</div></div>
        </div>
        <div className="a-tabs" style={{ margin: "10px 0 0", gap: 4 }}>
          {[["overview", "Overview"], ["subscription", "Subscription"], ["usage", "Usage"], ["invoices", "Invoice"], ["projects", "Projects"]].map(([id, l]) => (
            <button key={id} className={`a-tab${tab === id ? " is-on" : ""}`} style={{ height: 30, padding: "0 9px", fontSize: 12.5 }} onClick={() => (id === "overview" ? setTab(id) : navigate(`/admin/customers/${row.id}/${id}`))}>{l}</button>
          ))}
        </div>
        <div className="a-mini">
          <div><span className="muted" style={{ fontSize: 12 }}>Credits Remaining</span><b>{fmtNum(row.creditsRemaining)} <small className="muted" style={{ fontWeight: 400 }}>/ {fmtNum(row.monthlyAllowance)}</small></b><Bar value={row.creditsRemaining} max={Math.max(row.monthlyAllowance, row.creditsRemaining)} /></div>
          <div><span className="muted" style={{ fontSize: 12 }}>Monthly Usage</span><b>{fmtNum(row.monthlyUsage.used)} ({pct}%)</b><Bar value={row.monthlyUsage.used} max={row.monthlyUsage.limit} tone="violet" /></div>
        </div>
        <dl className="a-kv">
          <A.user /><dt>Contact</dt><dd><span style={{ color: "#a5b4fc" }}>{row.contact?.email ?? "—"}</span><br /><small className="muted">{row.contact?.name ?? ""}</small></dd>
          <A.building /><dt>Organization ID</dt><dd><CopyId value={row.organizationId} label="organization id" /></dd>
          <A.calendar /><dt>Customer Since</dt><dd>{fmtDate(row.createdAt)}</dd>
          <A.clock /><dt>Renewal Date</dt><dd>{row.renewalAt ? <>{fmtDate(row.renewalAt)} <span style={{ color: renew.soon ? "#f87171" : "var(--muted)" }}>({renew.text})</span></> : "—"}</dd>
          <A.key /><dt>Stripe Customer ID</dt><dd>{c ? <CopyId value={c.stripe.customerId} label="Stripe customer id" /> : <Skeleton h={14} w={120} />}</dd>
          <A.sub /><dt>Subscription ID</dt><dd>{c ? <CopyId value={c.stripe.subscriptionId} label="subscription id" /> : <Skeleton h={14} w={120} />}</dd>
        </dl>
        <div className="a-actions">
          <button className="btn btn--primary" onClick={() => setModal("plan")} data-testid="side-manage-plan"><A.edit size={15} /> Manage Plan</button>
          <button className="btn" onClick={() => setModal("credits")} data-testid="side-adjust-credits"><A.coins size={15} /> Adjust Credits</button>
          <CustomerActionsMenu c={row} label="More" compact />
        </div>
        <ErrorBox error={q.error} retry={q.reload} />
        <ActionModals c={row} kind={modal} onClose={() => setModal(null)} />
      </div>
    </Card>
  );
}
