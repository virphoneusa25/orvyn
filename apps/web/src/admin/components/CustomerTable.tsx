import { useState } from "react";
import { navigate } from "../../lib/router";
import { useDebounced, useQuery } from "../query";
import { fmtDate, fmtIn, fmtNum } from "../format";
import { A } from "./AIcons";
import { CustomerActionsMenu } from "./CustomerActions";
import { AddCustomerModal } from "./AddCustomer";
import { Bar, Empty, ErrorBox, OrgLogo, Pager, SkeletonRows, StatusBadge } from "./UI";
import { canDo, useAdmin } from "../AdminApp";

export interface CustomerRow {
  id: string; organizationId: string; name: string; kind: string; contact: { userId: string; email: string; name: string | null } | null; members: number; createdAt: number;
  plan: { id: string; label: string; priceMonthlyUsd: number | null }; complimentary: boolean; status: string; subscriptionStatus: string;
  creditsRemaining: number; monthlyAllowance: number; monthlyUsage: { used: number; limit: number }; renewalAt: number | null; cycleEnd: number | null;
}
export interface CustomerList { total: number; page: number; pageSize: number; customers: CustomerRow[]; counts: Record<string, number> }

const FILTERS: [string, string][] = [["all", "All"], ["active", "Active"], ["past_due", "Past Due"], ["trial", "Trial"], ["cancelled", "Cancelled"], ["enterprise", "Enterprise"], ["paused", "Paused"]];

/** The production customers table: server-side search, filters and pagination (never every customer at once). */
export function CustomerTable({ pageSize = 25, selected, onSelect, initialFilter = "all", title = true }: { pageSize?: number; selected?: string | null; onSelect?: (row: CustomerRow) => void; initialFilter?: string; title?: boolean }) {
  const me = useAdmin();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState(initialFilter);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState("");
  const [adding, setAdding] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const dq = useDebounced(q.trim(), 300);
  const path = `/admin/customers?filter=${filter}&page=${page}&pageSize=${pageSize}${dq ? `&q=${encodeURIComponent(dq)}` : ""}${sort ? `&sort=${sort}` : ""}`;
  const list = useQuery<CustomerList>(path, { staleMs: 15_000 });
  const rows = list.data?.customers ?? [];
  const open = (r: CustomerRow) => (onSelect ? onSelect(r) : navigate(`/admin/customers/${r.id}`));
  return (
    <div data-testid="customer-table">
      {title ? (
        <div className="a-card__head" style={{ flexWrap: "wrap" }}>
          <div><h3>Customers</h3><div className="muted" style={{ fontSize: 13 }}>Manage all customers, subscriptions and account activity.</div></div>
          <span style={{ flex: 1 }} />
          <label className="a-mini-search"><A.search size={16} /><input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search customers…" aria-label="Search customers" data-testid="customer-search" /></label>
          <select className="input select" aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value)} style={{ height: 38 }}>
            <option value="">Newest</option><option value="name">Name</option><option value="renewal">Renewal date</option>
          </select>
          {canDo(me, "support.write") ? <button className="btn btn--primary" onClick={() => setAdding(true)} data-testid="add-customer"><A.plus size={16} /> Add Customer</button> : null}
        </div>
      ) : null}
      <div className="a-tabs" role="tablist" aria-label="Filter customers">
        {FILTERS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={filter === id} className={`a-tab${filter === id ? " is-on" : ""}`} onClick={() => { setFilter(id); setPage(1); }} data-testid={`filter-${id}`}>
            {label}{list.data ? ` (${fmtNum(list.data.counts[id] ?? 0)})` : ""}
          </button>
        ))}
      </div>
      <ErrorBox error={list.error} retry={list.reload} />
      {list.loading && !list.data ? <SkeletonRows rows={Math.min(pageSize, 8)} /> : null}
      {list.data && !rows.length ? <Empty icon="users" title={dq ? "No customers match" : "No customers yet"}>{dq ? "Try a different name, email or id." : "New sign-ups appear here."}</Empty> : null}
      {rows.length ? (
        <div className="a-table-wrap">
          <table className="a-table">
            <thead><tr>
              <th style={{ width: 28 }}><input type="checkbox" className="a-check" aria-label="Select all on this page" checked={rows.every((r) => checked.has(r.id))} onChange={(e) => setChecked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} /></th>
              <th>Organization</th><th>Contact</th><th>Plan</th><th>Status</th><th>Credits Remaining</th><th>Monthly Usage</th><th>Renewal Date</th><th style={{ width: 60 }}>Actions</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const pctUsed = r.monthlyUsage.limit ? Math.round((r.monthlyUsage.used / r.monthlyUsage.limit) * 100) : 0;
                const renew = fmtIn(r.renewalAt);
                return (
                  <tr key={r.id} className={selected === r.id ? "is-selected" : ""} onClick={() => open(r)} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") open(r); }} data-testid="customer-row" data-id={r.id}>
                    <td onClick={(e) => e.stopPropagation()}><input type="checkbox" className="a-check" aria-label={`Select ${r.name}`} checked={checked.has(r.id)} onChange={(e) => { const n = new Set(checked); if (e.target.checked) n.add(r.id); else n.delete(r.id); setChecked(n); }} /></td>
                    <td><div className="a-org"><OrgLogo name={r.name} seed={r.id} /><div style={{ minWidth: 0 }}><b>{r.name}</b><small>{r.contact?.email.split("@")[1] ?? (r.kind === "company" ? "Business" : "Personal")}</small></div></div></td>
                    <td>{r.contact?.email ?? "—"}<small>{r.contact?.name ?? ""}</small></td>
                    <td>{r.plan.label}<small>{r.complimentary ? "Complimentary" : r.plan.priceMonthlyUsd ? `$${r.plan.priceMonthlyUsd}/mo` : r.plan.priceMonthlyUsd === null ? "Custom" : "Free"}</small></td>
                    <td><StatusBadge status={r.status} /></td>
                    <td className="a-cellbar">{fmtNum(r.creditsRemaining)}<Bar value={r.creditsRemaining} max={Math.max(r.monthlyAllowance, r.creditsRemaining)} /></td>
                    <td className="a-cellbar">{fmtNum(r.monthlyUsage.used)} ({pctUsed}%)<Bar value={r.monthlyUsage.used} max={r.monthlyUsage.limit} tone={pctUsed >= 100 ? "bad" : "violet"} /></td>
                    <td>{r.renewalAt ? <>{fmtDate(r.renewalAt)}<small style={{ color: renew.overdue ? "#f87171" : undefined }}>{renew.text}</small></> : <span className="muted">—</span>}</td>
                    <td><CustomerActionsMenu c={r} kebab /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {list.data && list.data.total > 0 ? <Pager page={page} pageSize={pageSize} total={list.data.total} onPage={setPage} /> : null}
      {adding ? <AddCustomerModal onClose={() => setAdding(false)} /> : null}
    </div>
  );
}
