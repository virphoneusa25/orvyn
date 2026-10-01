import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "./admin.css";
import { api, ApiError } from "../lib/api";
import { match, navigate, useLocation } from "../lib/router";
import { useStore } from "../lib/store";
import { appUrl } from "../lib/surface";
import { Orb } from "../components/Orb";
import icon from "../assets/icon.png";
import { A, type AIconName } from "./components/AIcons";
import { useDebounced, useQuery } from "./query";
import { Dashboard } from "./pages/Dashboard";
import { CustomersPage } from "./pages/Customers";
import { CustomerAccount } from "./pages/CustomerAccount";
import { Organizations, Subscriptions, UsageCredits, Invoices, Support } from "./pages/Lists";
import { Plans, Topups, Flags, Integrations, EmailTemplates } from "./pages/Platform";
import { SoftwareReleases } from "./pages/SoftwareReleases";
import { ProviderCosts, SystemHealth, Workers, Backups, AuditLogs, StaffSettings } from "./pages/Operations";

export interface AdminMe { staff: { id: string; email: string; name: string | null; role: string }; permissions: string[] }
const Ctx = createContext<AdminMe | null>(null);
export const useAdmin = () => useContext(Ctx)!;
export const canDo = (me: AdminMe, p: string) => me.permissions.includes(p);

const ROLE_LABEL: Record<string, string> = { super_admin: "Super Admin", billing: "Billing Admin", support: "Support", readonly: "Read-only" };

const NAV: { section?: string; items: { to: string; label: string; icon: AIconName; perm?: string }[] }[] = [
  { items: [{ to: "/admin", label: "Dashboard", icon: "dashboard" }] },
  { section: "Customers", items: [
    { to: "/admin/customers", label: "Customers", icon: "users" },
    { to: "/admin/organizations", label: "Organizations", icon: "org" },
    { to: "/admin/subscriptions", label: "Subscriptions", icon: "sub" },
    { to: "/admin/usage", label: "Usage & Credits", icon: "coins" },
    { to: "/admin/invoices", label: "Invoices", icon: "invoice" },
    { to: "/admin/support", label: "Support", icon: "support" },
  ] },
  { section: "Platform", items: [
    { to: "/admin/plans", label: "Plans & Pricing", icon: "tag" },
    { to: "/admin/topups", label: "Top-up Products", icon: "topup" },
    { to: "/admin/flags", label: "Feature Flags", icon: "flag" },
    { to: "/admin/integrations", label: "Integrations", icon: "plug" },
    { to: "/admin/email-templates", label: "Email Templates", icon: "mail" },
    { to: "/admin/releases", label: "Software Releases", icon: "layers" },
  ] },
  { section: "Operations", items: [
    { to: "/admin/provider-costs", label: "Provider Costs", icon: "dollar", perm: "costs.read" },
    { to: "/admin/health", label: "System Health", icon: "heart" },
    { to: "/admin/workers", label: "Workers & Sessions", icon: "cpu" },
    { to: "/admin/backups", label: "Backups", icon: "db" },
    { to: "/admin/audit", label: "Audit Logs", icon: "audit" },
    { to: "/admin/settings", label: "Settings", icon: "gear" },
  ] },
];

const TITLES: [RegExp, string, string][] = [
  [/^\/admin\/?$/, "Admin Dashboard", "Monitor, manage and grow the ORVYN platform."],
  [/^\/admin\/customers\/[^/]+/, "Customer Account", "Manage customer details, subscription, usage, projects and support."],
  [/^\/admin\/customers/, "Customers", "Manage all customers, subscriptions and account activity."],
  [/^\/admin\/organizations/, "Organizations", "Every workspace on ORVYN and who is in it."],
  [/^\/admin\/subscriptions/, "Subscriptions", "Plans, renewals and payment state."],
  [/^\/admin\/usage/, "Usage & Credits", "Credit consumption and staff adjustments."],
  [/^\/admin\/invoices/, "Invoices", "Every invoice, read from Stripe."],
  [/^\/admin\/support/, "Support", "Internal notes, paused accounts and support actions."],
  [/^\/admin\/plans/, "Plans & Pricing", "The commercial plans and their Stripe prices."],
  [/^\/admin\/topups/, "Top-up Products", "Credit packs and their sales."],
  [/^\/admin\/flags/, "Feature Flags", "Runtime switches of this deployment."],
  [/^\/admin\/integrations/, "Integrations", "Payments, email, sign-in and infrastructure."],
  [/^\/admin\/email-templates/, "Email Templates", "Every email ORVYN sends."],
  [/^\/admin\/releases/, "Software Releases", "ORVYN Desktop versions, rollout, and adoption."],
  [/^\/admin\/provider-costs/, "Provider Costs", "Internal model costs against credits charged."],
  [/^\/admin\/health/, "System Health", "Live checks of every ORVYN service."],
  [/^\/admin\/workers/, "Workers & Sessions", "Execution workers, runs and signed-in sessions."],
  [/^\/admin\/backups/, "Backups", "Backup runs and restore drills."],
  [/^\/admin\/audit/, "Audit Logs", "Every staff action, append-only."],
  [/^\/admin\/settings/, "Settings", "Staff members and roles."],
];

export default function AdminApp() {
  const [me, setMe] = useState<AdminMe | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  useEffect(() => { api<AdminMe>("/admin/me").then(setMe).catch((e) => setErr(e)); }, []);
  if (err) return <Denied error={err} />;
  if (!me) return <div className="a-denied"><div className="muted">Loading Admin Portal…</div></div>;
  return <Ctx.Provider value={me}><AdminShell /></Ctx.Provider>;
}

function Denied({ error }: { error: ApiError }) {
  return (
    <div className="a-denied" data-testid="admin-denied">
      <div className="card">
        <A.shield size={36} />
        <h2 style={{ margin: "10px 0 6px" }}>{error.status === 403 ? "Admin access only" : "Couldn't open the Admin Portal"}</h2>
        <p className="muted">{error.status === 403 ? "This area is for ORVYN staff. Your account doesn't have admin access." : error.message}</p>
        <button className="btn btn--primary" onClick={() => { const u = appUrl(); if (u.startsWith("/")) navigate(u); else location.href = u; }}>Back to ORVYN Cloud</button>
      </div>
    </div>
  );
}

function AdminShell() {
  const { path } = useLocation();
  const me = useAdmin();
  const title = TITLES.find(([re]) => re.test(path)) ?? TITLES[0]!;
  const health = useQuery<{ status: string }>("/admin/health", { refreshMs: 60_000, staleMs: 30_000 });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const active = (to: string) => (to === "/admin" ? path === "/admin" || path === "/admin/" : path === to || path.startsWith(`${to}/`));
  return (
    <div className="adm">
      <aside className="adm-side" aria-label="Admin navigation">
        <button className="adm-brand" onClick={() => navigate("/admin")} aria-label="Admin dashboard">
          <span className="adm-brand__mark"><Orb /></span>
          <span><div className="adm-brand__word">ORVYN</div><div className="adm-brand__sub">Admin Portal</div></span>
        </button>
        <nav className="adm-nav">
          {NAV.map((g, gi) => (
            <div key={gi}>
              {g.section ? (
                <button className="adm-nav__section" onClick={() => setCollapsed((c) => ({ ...c, [g.section!]: !c[g.section!] }))} aria-expanded={!collapsed[g.section]}>
                  {g.section}{collapsed[g.section] ? <A.chevDown size={14} /> : <A.chevUp size={14} />}
                </button>
              ) : null}
              {!g.section || !collapsed[g.section] ? g.items.filter((i) => !i.perm || canDo(me, i.perm)).map((i) => {
                const Ic = A[i.icon];
                return (
                  <button key={i.to} className={`adm-nav__item${active(i.to) ? " is-active" : ""}`} aria-current={active(i.to) ? "page" : undefined} onClick={() => navigate(i.to)} title={i.label}>
                    <Ic /> <span>{i.label}</span>
                  </button>
                );
              }) : null}
            </div>
          ))}
        </nav>
        <div className="adm-side__foot">
          <img src={icon} alt="" />
          <div><b>ORVYN Cloud</b><span><i className={`adm-dot adm-dot--${health.data?.status === "operational" || !health.data ? "ok" : health.data.status}`} style={{ width: 8, height: 8 }} />{health.data?.status === "operational" ? "All systems operational" : health.data ? `Systems ${health.data.status}` : "Checking…"}</span></div>
          <span className="adm-side__ver">v2.0.0</span>
        </div>
      </aside>
      <div className="adm-main">
        <header className="adm-top">
          <div className="adm-top__title"><h1>{title[1]}</h1><p>{title[2]}</p></div>
          <GlobalSearch />
          <button className="adm-health" onClick={() => navigate("/admin/health")} aria-label="System health">
            <i className={`adm-dot${health.data && health.data.status !== "operational" ? ` adm-dot--${health.data.status}` : ""}`} />
            <div><b>System Health</b><span style={{ color: health.data?.status === "operational" ? "#4ade80" : "#fbbf24" }}>{health.data?.status === "operational" ? "All Systems Operational" : health.data ? health.data.status === "down" ? "Service down" : "Degraded" : "Checking…"}</span></div>
          </button>
          <Notifications />
          <AccountMenu />
        </header>
        <main className="adm-content">{page(path)}</main>
      </div>
    </div>
  );
}

function page(path: string): ReactNode {
  let m: Record<string, string> | null;
  if (path === "/admin" || path === "/admin/") return <Dashboard />;
  if (path === "/admin/customers") return <CustomersPage />;
  if ((m = match("/admin/customers/:id", path))) return <CustomerAccount id={m.id!} tab="overview" />;
  if ((m = match("/admin/customers/:id/:tab", path))) return <CustomerAccount id={m.id!} tab={m.tab!} />;
  if (path === "/admin/organizations") return <Organizations />;
  if (path === "/admin/subscriptions") return <Subscriptions />;
  if (path === "/admin/usage") return <UsageCredits />;
  if (path === "/admin/invoices") return <Invoices />;
  if (path === "/admin/support") return <Support />;
  if (path === "/admin/plans") return <Plans />;
  if (path === "/admin/topups") return <Topups />;
  if (path === "/admin/flags") return <Flags />;
  if (path === "/admin/integrations") return <Integrations />;
  if (path === "/admin/email-templates") return <EmailTemplates />;
  if (path === "/admin/releases") return <SoftwareReleases />;
  if (path === "/admin/provider-costs") return <ProviderCosts />;
  if (path === "/admin/health") return <SystemHealth />;
  if (path === "/admin/workers") return <Workers />;
  if (path === "/admin/backups") return <Backups />;
  if (path === "/admin/audit") return <AuditLogs />;
  if (path === "/admin/settings") return <StaffSettings />;
  return <div className="a-empty"><b>Page not found</b><button className="btn" onClick={() => navigate("/admin")}>Dashboard</button></div>;
}

interface SearchResult {
  users: { userId: string; email: string; name: string | null; tenantId: string | null; organization: string | null }[];
  organizations: { organizationId: string; tenantId: string; name: string; kind: string }[];
  subscriptions: { tenantId: string; customer: string; subscriptionId: string | null; customerId: string | null; plan: string; status: string }[];
  invoices: { id: string; number: string | null; accountId: string | null; amountUsd: number; status: string }[];
}

function GlobalSearch() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  const dq = useDebounced(q.trim(), 250);
  const res = useQuery<SearchResult>(dq.length >= 2 ? `/admin/search?q=${encodeURIComponent(dq)}` : null, { staleMs: 10_000 });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); input.current?.focus(); setOpen(true); } };
    const onDown = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("keydown", onKey); window.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onDown); };
  }, []);
  const items = useMemo(() => {
    const r = res.data;
    if (!r) return [] as { group: string; title: string; sub: string; to: string }[];
    return [
      ...r.users.map((u) => ({ group: "Users", title: u.name ? `${u.name} · ${u.email}` : u.email, sub: u.organization ?? "", to: u.tenantId ? `/admin/customers/${u.tenantId}` : "/admin/customers" })),
      ...r.organizations.map((o) => ({ group: "Organizations", title: o.name, sub: o.kind === "company" ? "Business" : "Personal", to: `/admin/customers/${o.tenantId}` })),
      ...r.subscriptions.map((s) => ({ group: "Subscriptions", title: s.subscriptionId ?? s.customerId ?? s.customer, sub: `${s.customer} · ${s.plan} · ${s.status}`, to: `/admin/customers/${s.tenantId}/subscription` })),
      ...r.invoices.map((i) => ({ group: "Invoices", title: i.number ?? i.id, sub: `$${i.amountUsd.toFixed(2)} · ${i.status}`, to: i.accountId ? `/admin/customers/${i.accountId}/invoices` : "/admin/invoices" })),
    ];
  }, [res.data]);
  const go = (to: string) => { setOpen(false); setQ(""); navigate(to); };
  return (
    <div className="adm-search" ref={wrap}>
      <div className="adm-search__box">
        <A.search size={18} />
        <input ref={input} value={q} placeholder="Search users, orgs, subscriptions, invoices…" aria-label="Search users, organizations, subscriptions and invoices" data-testid="admin-search"
          onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            if (e.key === "Enter" && items[sel]) go(items[sel]!.to);
            if (e.key === "Escape") setOpen(false);
          }} />
        <kbd>Ctrl + K</kbd>
      </div>
      {open && dq.length >= 2 ? (
        <div className="adm-pop" role="listbox" aria-label="Search results">
          {res.loading ? <div className="a-empty">Searching…</div> : !items.length ? <div className="a-empty">No matches for “{dq}”.</div> : null}
          {items.map((it, i) => (
            <div key={`${it.group}${i}`}>
              {i === 0 || items[i - 1]!.group !== it.group ? <div className="adm-pop__group">{it.group}</div> : null}
              <button className={`adm-pop__item${i === sel ? " is-on" : ""}`} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => go(it.to)}>
                <span><b>{it.title}</b><small>{it.sub}</small></span>
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Notifications() {
  const n = useQuery<{ items: { id: string; level: string; title: string; detail: string; at: number; href?: string }[]; unread: number }>("/admin/notifications", { refreshMs: 60_000 });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => { const f = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }; window.addEventListener("mousedown", f); return () => window.removeEventListener("mousedown", f); }, []);
  return (
    <div className="adm-bell" ref={ref} style={{ position: "relative" }}>
      <button className="bell" aria-label={`Notifications${n.data?.unread ? ` (${n.data.unread})` : ""}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}><A.bell size={22} /></button>
      {n.data?.unread ? <span className="adm-bell__count">{n.data.unread}</span> : null}
      {open ? (
        <div className="adm-pop" style={{ left: "auto", right: 0, width: 340 }}>
          <div className="adm-pop__group">Notifications</div>
          {!n.data?.items.length ? <div className="a-empty">Nothing needs attention.</div> : n.data.items.map((i) => (
            <button key={i.id} className="adm-pop__item" onClick={() => { setOpen(false); if (i.href) navigate(i.href); }}>
              <i className={`adm-dot${i.level === "error" ? " adm-dot--down" : i.level === "warning" ? " adm-dot--degraded" : " adm-dot--muted"}`} style={{ width: 8, height: 8 }} />
              <span><b>{i.title}</b><small>{i.detail}</small></span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AccountMenu() {
  const me = useAdmin();
  const { signOut } = useStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => { const f = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }; window.addEventListener("mousedown", f); return () => window.removeEventListener("mousedown", f); }, []);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="adm-me" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} data-testid="admin-me">
        <span className="adm-me__av"><A.user size={20} /></span>
        <div><b>{me.staff.name || "Admin"}</b><span>{ROLE_LABEL[me.staff.role] ?? me.staff.role}</span></div>
        <A.chevDown size={16} />
      </button>
      {open ? (
        <div className="adm-pop" role="menu" style={{ left: "auto", right: 0, width: 240 }}>
          <div className="adm-pop__group">{me.staff.email}</div>
          <button className="adm-pop__item" role="menuitem" onClick={() => { const u = appUrl(); if (u.startsWith("/")) navigate(u); else location.href = u; }}><A.eye size={16} /> <b>Open ORVYN Cloud</b></button>
          <button className="adm-pop__item" role="menuitem" onClick={() => { setOpen(false); navigate("/admin/settings"); }}><A.gear size={16} /> <b>Staff settings</b></button>
          <button className="adm-pop__item" role="menuitem" onClick={() => void signOut().then(() => navigate("/signin"))}><A.logout size={16} /> <b>Sign out</b></button>
        </div>
      ) : null}
    </div>
  );
}
