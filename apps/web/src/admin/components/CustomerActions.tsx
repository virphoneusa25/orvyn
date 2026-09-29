import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../../lib/api";
import { navigate } from "../../lib/router";
import { useStore } from "../../lib/store";
import { Modal } from "../../components/Bits";
import { canDo, useAdmin } from "../AdminApp";
import { invalidate, useQuery } from "../query";
import { fmtDate, fmtNum, rid } from "../format";
import { A, type AIconName } from "./AIcons";

export interface CustomerLite { id: string; name: string; status: string; contact: { email: string; name: string | null } | null; plan: { id: string; label: string }; complimentary?: boolean }
export type ActionKind = "plan" | "credits" | "reset" | "verify" | "note" | "pause" | "reactivate" | "viewas" | "profile";

/** Refresh everything that shows this customer after an action. */
export function refreshCustomer(id: string) {
  invalidate(`/admin/customers/${id}`);
  invalidate("/admin/customers?");
  invalidate("/admin/dashboard");
  invalidate("/admin/audit");
  invalidate("/admin/support");
  invalidate("/admin/usage");
}

/** The Customer Actions button + grouped drawer (as in the Customer Account mockup). */
export function CustomerActionsMenu({ c, label = "Customer Actions", compact, kebab }: { c: CustomerLite; label?: string; compact?: boolean; kebab?: boolean }) {
  const me = useAdmin();
  const [open, setOpenState] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const setOpen = (v: boolean | ((x: boolean) => boolean)) => {
    const next = typeof v === "function" ? v(open) : v;
    if (next && ref.current) {
      const r = ref.current.getBoundingClientRect();
      setPos({ top: Math.min(r.bottom + 8, window.innerHeight - 220), right: Math.max(8, window.innerWidth - r.right) });
    }
    setOpenState(next);
  };
  const [modal, setModal] = useState<ActionKind | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const f = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", f); window.addEventListener("keydown", k);
    return () => { window.removeEventListener("mousedown", f); window.removeEventListener("keydown", k); };
  }, []);
  useEffect(() => { if (open) (ref.current?.querySelector(".a-drawer__item") as HTMLButtonElement | null)?.focus(); }, [open]);
  const paused = c.status === "paused";
  const pick = (k: ActionKind) => { setOpen(false); setModal(k); };
  const go = (to: string) => { setOpen(false); navigate(to); };
  const item = (ic: AIconName, title: string, sub: string, onClick: () => void, opts: { tone?: "warn" | "ok" | "danger"; disabled?: boolean; testid?: string } = {}) => {
    const Ic = A[ic];
    return (
      <button className={`a-drawer__item${opts.tone ? ` a-drawer__item--${opts.tone}` : ""}`} role="menuitem" disabled={opts.disabled} onClick={onClick} data-testid={opts.testid}>
        <Ic /><span><b>{title}</b><span>{sub}</span></span>
      </button>
    );
  };
  return (
    <div className="a-actions-wrap" ref={ref} onClick={(e) => e.stopPropagation()}>
      {kebab ? <button className="a-kebab" aria-label={`Actions for ${c.name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="row-actions"><A.more size={18} /></button> : <button className={compact ? "btn btn--sm" : "btn"} style={compact ? undefined : { borderColor: "rgba(99,102,241,.6)", color: "#a5b4fc" }} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} data-testid="customer-actions">
        {label} <A.chevDown size={16} />
      </button>}
      {!compact && !kebab ? <button className="btn" aria-label="More actions" onClick={() => setOpen((v) => !v)} style={{ width: 40, padding: 0, borderColor: "rgba(99,102,241,.6)" }}><A.moreV size={18} /></button> : null}
      {open ? (
        <div className="a-drawer" role="menu" aria-label="Customer actions" data-testid="actions-drawer" style={pos ? { top: pos.top, right: pos.right, maxHeight: `calc(100vh - ${pos.top + 12}px)` } : undefined}>
          <div className="a-drawer__group">View &amp; Explore</div>
          {item("userSearch", "View Account", "See customer details and settings", () => go(`/admin/customers/${c.id}`))}
          {item("sub", "Open Subscription", "View plan, billing and renewal", () => go(`/admin/customers/${c.id}/subscription`))}
          {item("coins", "Usage & Credits", "View usage, limits and credits", () => go(`/admin/customers/${c.id}/usage`))}
          {item("invoice", "Invoices", "View billing history and invoices", () => go(`/admin/customers/${c.id}/invoices`))}
          {item("folder", "Projects & Workspaces", "Manage projects and workspaces", () => go(`/admin/customers/${c.id}/projects`))}
          {item("eye", "View as Customer", "Open read-only customer view", () => pick("viewas"), { disabled: !canDo(me, "support.write"), testid: "act-viewas" })}
          <div className="a-drawer__sep" />
          <div className="a-drawer__group">Manage Account</div>
          {item("sub", "Manage Plan", "Change plan or billing cycle", () => pick("plan"), { disabled: !canDo(me, "billing.write"), testid: "act-plan" })}
          {item("coins", "Adjust Credits", "Add or remove credits", () => pick("credits"), { disabled: !canDo(me, "billing.write"), testid: "act-credits" })}
          {item("user", "Send Password Reset", "Send account recovery email", () => pick("reset"), { disabled: !canDo(me, "support.write"), testid: "act-reset" })}
          {item("mailCheck", "Resend Verification", "Resend email verification", () => pick("verify"), { disabled: !canDo(me, "support.write"), testid: "act-verify" })}
          <div className="a-drawer__sep" />
          <div className="a-drawer__group">Support &amp; Access</div>
          {item("note", "Add Support Note", "Add an internal support note", () => pick("note"), { disabled: !canDo(me, "support.write"), testid: "act-note" })}
          {!paused ? item("pause", "Pause Account", "Temporarily suspend access", () => pick("pause"), { tone: "warn", disabled: !canDo(me, "account.suspend"), testid: "act-pause" }) : null}
          {paused ? item("play", "Reactivate Account", "Restore account access", () => pick("reactivate"), { tone: "ok", disabled: !canDo(me, "account.suspend"), testid: "act-reactivate" }) : null}
          <div className="a-drawer__sep" />
          <div className="a-drawer__group">Monitoring</div>
          {item("audit", "View Audit Log", "See all account activity", () => go(`/admin/customers/${c.id}/audit`))}
        </div>
      ) : null}
      <ActionModals c={c} kind={modal} onClose={() => setModal(null)} />
    </div>
  );
}

export function ActionModals({ c, kind, onClose }: { c: CustomerLite; kind: ActionKind | null; onClose: () => void }) {
  if (!kind) return null;
  if (kind === "credits") return <CreditAdjustModal c={c} onClose={onClose} />;
  if (kind === "plan") return <PlanManager c={c} onClose={onClose} />;
  if (kind === "note") return <SupportNoteModal c={c} onClose={onClose} />;
  if (kind === "pause") return <PauseModal c={c} onClose={onClose} />;
  if (kind === "viewas") return <ViewAsModal c={c} onClose={onClose} />;
  if (kind === "reactivate") return <SimpleConfirm c={c} onClose={onClose} title="Reactivate account?" body={`${c.name} gets access back right away. Their data was never changed.`} action="Reactivate" path="reactivate" done="Account reactivated." withReason />;
  if (kind === "reset") return <SimpleConfirm c={c} onClose={onClose} title="Send password reset?" body={`ORVYN emails ${c.contact?.email ?? "the account owner"} a single-use link to choose a new password. No password is ever shown to staff.`} action="Send reset email" path="password-reset" done="Password reset email sent." />;
  if (kind === "verify") return <SimpleConfirm c={c} onClose={onClose} title="Resend verification?" body={`ORVYN emails ${c.contact?.email ?? "the account owner"} a new verification link.`} action="Send verification" path="resend-verification" done="Verification email sent." />;
  return null;
}

function useAct(c: CustomerLite, onClose: () => void) {
  const { toast } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (path: string, body: unknown, done: string, method = "POST") => {
    setBusy(true); setError(null);
    try {
      const r = await api<any>(`/admin/customers/${encodeURIComponent(c.id)}/${path}`, { method, body });
      refreshCustomer(c.id);
      toast(typeof done === "string" ? done : "Done.");
      onClose();
      return r;
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
    return null;
  };
  return { busy, error, run, setError };
}

function SimpleConfirm({ c, onClose, title, body, action, path, done, withReason }: { c: CustomerLite; onClose: () => void; title: string; body: string; action: string; path: string; done: string; withReason?: boolean }) {
  const { busy, error, run } = useAct(c, onClose);
  const [reason, setReason] = useState("");
  return (
    <Modal title={title} onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>{body}</p>
      {withReason ? <div className="a-field"><label htmlFor="sc-reason">Note (optional)</label><input id="sc-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></div> : null}
      {error ? <div className="error" role="alert">{error}</div> : null}
      <div className="modal__actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" disabled={busy} onClick={() => void run(path, withReason ? { reason } : {}, done)} data-testid="confirm-action">{busy ? "Working…" : action}</button>
      </div>
    </Modal>
  );
}

const CATEGORIES: [string, string][] = [["promotional", "Promotional credits"], ["billing_correction", "Billing correction"], ["refund_adjustment", "Refund adjustment"], ["goodwill", "Goodwill"], ["other", "Other"]];

export function CreditAdjustModal({ c, onClose, initial = "add" }: { c: CustomerLite; onClose: () => void; initial?: "add" | "remove" }) {
  const { busy, error, run, setError } = useAct(c, onClose);
  const [mode, setMode] = useState<"add" | "remove">(initial);
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("promotional");
  const [reason, setReason] = useState("");
  const [requestId] = useState(rid);
  const detail = useQuery<{ customer: { wallet: { available: number; purchased: number; included: number } } }>(`/admin/customers/${c.id}`);
  const w = detail.data?.customer.wallet;
  const n = Math.round(Number(amount.replace(/,/g, "")));
  const valid = Number.isFinite(n) && n > 0 && reason.trim().length >= 3 && (mode === "add" || !w || n <= w.available);
  return (
    <Modal title="Adjust credits" onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>{c.name} · {w ? `${fmtNum(w.available)} credits available (${fmtNum(w.purchased)} top-up, ${fmtNum(w.included)} included)` : "loading balance…"}</p>
      <div className="a-seg" role="tablist" style={{ marginBottom: 12 }}>
        <button role="tab" aria-selected={mode === "add"} className={mode === "add" ? "is-on" : ""} onClick={() => setMode("add")}><A.plus size={14} /> Add credits</button>
        <button role="tab" aria-selected={mode === "remove"} className={mode === "remove" ? "is-on" : ""} onClick={() => setMode("remove")}><A.minus size={14} /> Remove credits</button>
      </div>
      <div className="a-field"><label htmlFor="adj-amount">Credits</label><input id="adj-amount" className="input" inputMode="numeric" value={amount} onChange={(e) => { setAmount(e.target.value); setError(null); }} placeholder="5,000" data-testid="adjust-amount" /></div>
      <div className="a-field"><label htmlFor="adj-cat">Type</label>
        <select id="adj-cat" className="input select" value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
      <div className="a-field"><label htmlFor="adj-reason">Reason (recorded on the ledger)</label><textarea id="adj-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Launch promotion for early customers" data-testid="adjust-reason" /></div>
      <p className="muted" style={{ fontSize: 12.5 }}>This writes an immutable ledger entry with your name, the reason and the time. Balances are never overwritten{mode === "remove" ? "; top-up credits are removed first" : ""}.</p>
      {error ? <div className="error" role="alert">{error}</div> : null}
      <div className="modal__actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" disabled={!valid || busy} data-testid="adjust-submit"
          onClick={() => void run("credits/adjust", { credits: mode === "add" ? n : -n, reason: reason.trim(), category, requestId }, `${mode === "add" ? "Added" : "Removed"} ${fmtNum(n)} credits.`)}>
          {busy ? "Saving…" : `${mode === "add" ? "Add" : "Remove"} ${Number.isFinite(n) && n > 0 ? fmtNum(n) : ""} credits`}
        </button>
      </div>
    </Modal>
  );
}

interface SubInfo {
  plan: { id: string; label: string }; walletStatus: string; cycleEnd: number | null; customerId: string | null; stripe: string;
  subscription: null | { id: string; status: string; cancelAtPeriodEnd: boolean; currentPeriodEnd: number | null; planId: string | null; period: "monthly" | "yearly"; scheduleId: string | null };
  plans: { id: string; label: string; priceMonthlyUsd: number | null; priceAnnualUsd: number | null; monthlyCredits: number; monthly: boolean; yearly: boolean }[];
}

export function PlanManager({ c, onClose }: { c: CustomerLite; onClose: () => void }) {
  const me = useAdmin();
  const { toast } = useStore();
  const q = useQuery<SubInfo>(`/admin/customers/${c.id}/subscription`, { staleMs: 0 });
  const [planId, setPlanId] = useState<string>("");
  const [period, setPeriod] = useState<"monthly" | "yearly">("monthly");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const s = q.data?.subscription;
  const live = Boolean(s && !["canceled", "incomplete_expired"].includes(s.status));
  useEffect(() => { if (s?.period) setPeriod(s.period); }, [s?.period]);
  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(true); setError(null);
    try {
      const r = await api<any>(`/admin/customers/${c.id}/plan`, { method: "POST", body: { action, planId, period, reason, ...extra } });
      refreshCustomer(c.id);
      q.reload();
      if (r.url) { setLink(r.url); toast("Checkout link created."); }
      else { toast(r.message ?? "Saved."); onClose(); }
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const priceOf = (p: SubInfo["plans"][number]) => (period === "yearly" ? (p.priceAnnualUsd ? `$${p.priceAnnualUsd}/yr` : "—") : p.priceMonthlyUsd === null ? "Custom" : `$${p.priceMonthlyUsd}/mo`);
  const available = (p: SubInfo["plans"][number]) => (period === "yearly" ? p.yearly : p.monthly);
  const selected = q.data?.plans.find((p) => p.id === planId);
  return (
    <Modal title="Manage plan" onClose={onClose}>
      <div className="a-modal--wide" style={{ width: "auto" }}>
        {q.loading ? <p className="muted">Reading the subscription from Stripe…</p> : null}
        {q.error ? <div className="error">{q.error.message}</div> : null}
        {q.data ? (
          <>
            <dl className="a-kv2" style={{ marginBottom: 12 }}>
              <dt>Current plan</dt><dd><b>{q.data.plan.label}</b>{c.complimentary ? " (complimentary)" : ""}</dd>
              <dt>Stripe subscription</dt><dd>{q.data.stripe === "not_configured" ? "Stripe isn't configured" : q.data.stripe === "unavailable" ? "Stripe unavailable right now" : s ? `${s.status}${s.cancelAtPeriodEnd ? " · cancels at renewal" : ""} · ${s.period}` : "None"}</dd>
              <dt>{s?.cancelAtPeriodEnd ? "Ends" : "Renews"}</dt><dd>{fmtDate(s?.currentPeriodEnd ?? q.data.cycleEnd)}</dd>
            </dl>
            <div className="a-seg" style={{ marginBottom: 6 }}>
              <button className={period === "monthly" ? "is-on" : ""} onClick={() => setPeriod("monthly")}>Monthly</button>
              <button className={period === "yearly" ? "is-on" : ""} onClick={() => setPeriod("yearly")}>Yearly</button>
            </div>
            <div className="a-plan-opt" role="radiogroup" aria-label="Plan">
              {q.data.plans.filter((p) => p.id !== "free").map((p) => (
                <button key={p.id} role="radio" aria-checked={planId === p.id} className={planId === p.id ? "is-on" : ""} onClick={() => setPlanId(p.id)} data-testid={`plan-opt-${p.id}`}>
                  <b>{p.label}{p.id === q.data!.plan.id ? " · current" : ""}</b>
                  <small>{priceOf(p)} · {fmtNum(p.monthlyCredits)} credits{p.id !== "enterprise" && !available(p) ? " · no Stripe price" : ""}</small>
                </button>
              ))}
            </div>
            <div className="a-field"><label htmlFor="pm-reason">Reason (audited)</label><input id="pm-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer requested upgrade" /></div>
            {error ? <div className="error" role="alert">{error}</div> : null}
            {link ? <div className="notice">Send this checkout link to the customer: <a href={link} target="_blank" rel="noopener noreferrer">{link}</a></div> : null}
            <div className="a-actions" style={{ flexWrap: "wrap" }}>
              {live ? (
                <>
                  <button className="btn btn--primary" disabled={busy || !selected || selected.id === "enterprise" || !available(selected)} onClick={() => void act("change")} data-testid="plan-change-now">Change now (prorated)</button>
                  <button className="btn" disabled={busy || !selected || selected.id === "enterprise" || !available(selected)} onClick={() => void act("schedule")} data-testid="plan-schedule">At renewal</button>
                  {s!.cancelAtPeriodEnd
                    ? <button className="btn" disabled={busy} onClick={() => void act("resume")} data-testid="plan-resume">Reactivate renewal</button>
                    : <button className="btn btn--danger" disabled={busy} onClick={() => void act("cancel_at_period_end")} data-testid="plan-cancel">Cancel at renewal</button>}
                </>
              ) : (
                <>
                  <button className="btn btn--primary" disabled={busy || !selected || selected.id === "enterprise" || !available(selected) || q.data.stripe !== "ok"} onClick={() => void act("checkout_link")} data-testid="plan-checkout-link">Create checkout link</button>
                  {me.staff.role === "super_admin" ? <button className="btn" disabled={busy || !selected || reason.trim().length < 3} onClick={() => void act("complimentary")} data-testid="plan-comp">Assign complimentary</button> : null}
                  {me.staff.role === "super_admin" && c.complimentary ? <button className="btn btn--danger" disabled={busy} onClick={() => void act("end_complimentary")}>End complimentary plan</button> : null}
                </>
              )}
            </div>
            <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>{live ? "Changes go to Stripe. The plan and its credits switch when Stripe confirms the invoice." : "Without a Stripe subscription the customer pays through checkout. A complimentary plan (super admin) grants the plan's credits with no charge and is audited."}</p>
          </>
        ) : null}
        <div className="modal__actions"><button className="btn" onClick={onClose}>Close</button></div>
      </div>
    </Modal>
  );
}

function SupportNoteModal({ c, onClose }: { c: CustomerLite; onClose: () => void }) {
  const { busy, error, run } = useAct(c, onClose);
  const [body, setBody] = useState("");
  return (
    <Modal title="Add support note" onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>Internal only — the customer never sees notes. Your name and the time are recorded.</p>
      <div className="a-field"><label htmlFor="note-body">Note</label><textarea id="note-body" value={body} onChange={(e) => setBody(e.target.value)} data-testid="note-body" /></div>
      {error ? <div className="error" role="alert">{error}</div> : null}
      <div className="modal__actions"><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn--primary" disabled={busy || !body.trim()} onClick={() => void run("support-note", { body }, "Note added.")} data-testid="note-submit">Add note</button></div>
    </Modal>
  );
}

const PAUSE_REASONS: [string, string][] = [["billing", "Billing"], ["compliance", "Compliance"], ["security", "Security"], ["support", "Support"], ["other", "Other"]];

function PauseModal({ c, onClose }: { c: CustomerLite; onClose: () => void }) {
  const { busy, error, run } = useAct(c, onClose);
  const [category, setCategory] = useState("billing");
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState("");
  return (
    <Modal title="Pause account" onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}><b style={{ color: "#fdba74" }}>{c.name}</b> will be able to sign in but not use ORVYN (Cloud or Desktop) until reactivated. No data is deleted and the subscription is not changed.</p>
      <div className="a-field"><label htmlFor="pause-cat">Reason</label><select id="pause-cat" className="input select" value={category} onChange={(e) => setCategory(e.target.value)}>{PAUSE_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
      <div className="a-field"><label htmlFor="pause-reason">Details</label><textarea id="pause-reason" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="pause-reason" /></div>
      <div className="a-field"><label htmlFor="pause-confirm">Type <b>PAUSE</b> to confirm</label><input id="pause-confirm" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} data-testid="pause-confirm" /></div>
      {error ? <div className="error" role="alert">{error}</div> : null}
      <div className="modal__actions"><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn--danger" disabled={busy || confirm !== "PAUSE" || reason.trim().length < 3} onClick={() => void run("suspend", { category, reason, confirm: true }, "Account paused.")} data-testid="pause-submit">Pause account</button></div>
    </Modal>
  );
}

function ViewAsModal({ c, onClose }: { c: CustomerLite; onClose: () => void }) {
  const { toast } = useStore();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setBusy(true); setError(null);
    // Open the tab first (popup blockers), then hand it the token by message — never in a URL.
    const win = window.open("/view-as", "_blank");
    try {
      const r = await api<{ token: string; expiresAt: number }>(`/admin/customers/${c.id}/view-as`, { method: "POST", body: { reason } });
      if (!win) throw new Error("Allow pop-ups for ORVYN to open the customer view.");
      const send = (ev: MessageEvent) => {
        if (ev.source !== win || ev.origin !== location.origin || ev.data?.type !== "orvyn:view-as-ready") return;
        win.postMessage({ type: "orvyn:view-as", token: r.token }, location.origin);
        window.removeEventListener("message", send);
      };
      window.addEventListener("message", send);
      refreshCustomer(c.id);
      toast("Customer view opened in a new tab (read-only, 30 minutes).");
      onClose();
    } catch (e: any) { win?.close(); setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal title="View as customer" onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>Opens ORVYN Cloud as <b>{c.contact?.email ?? c.name}</b> sees it, read-only, for 30 minutes. Nothing can be changed or sent, and the session is recorded in the audit log.</p>
      <div className="a-field"><label htmlFor="va-reason">Reason (audited)</label><input id="va-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ticket or request" /></div>
      {error ? <div className="error" role="alert">{error}</div> : null}
      <div className="modal__actions"><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn--primary" disabled={busy} onClick={() => void start()} data-testid="viewas-start">Open read-only view</button></div>
    </Modal>
  );
}

export function EditProfileModal({ c, profile, onClose }: { c: CustomerLite; profile: { website: string | null; industry: string | null; location: string | null }; onClose: () => void }) {
  const { busy, error, run } = useAct(c, onClose);
  const [f, setF] = useState({ website: profile.website ?? "", industry: profile.industry ?? "", location: profile.location ?? "" });
  return (
    <Modal title="Edit customer details" onClose={onClose}>
      {(["website", "industry", "location"] as const).map((k) => (
        <div className="a-field" key={k}><label htmlFor={`pf-${k}`}>{k[0]!.toUpperCase() + k.slice(1)}</label><input id={`pf-${k}`} className="input" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></div>
      ))}
      {error ? <div className="error" role="alert">{error}</div> : null}
      <div className="modal__actions"><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn--primary" disabled={busy} onClick={() => void run("profile", f, "Details saved.", "PUT")}>Save</button></div>
    </Modal>
  );
}

export function ActionButton({ children, onClick, primary, testid }: { children: ReactNode; onClick: () => void; primary?: boolean; testid?: string }) {
  return <button className={`btn${primary ? " btn--primary" : ""}`} onClick={onClick} data-testid={testid}>{children}</button>;
}
