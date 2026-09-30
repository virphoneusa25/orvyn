import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { date, money, num } from "../lib/format";
import { navigate, useLocation } from "../lib/router";
import { useStore } from "../lib/store";
import { useApi } from "../lib/useApi";
import { StatCards } from "../components/Stats";
import { Icon } from "../components/Icons";
import type { Account } from "./Home";

interface PlanRow { id: string; label: string; priceMonthlyUsd: number | null; priceAnnualUsd: number | null; monthlyCredits: number; rolling5h: number; rolling7d: number; parallelAgents: number; features: { premiumModels: string; teamSeats: number; priority: string; apiAccess: boolean } }

export function Billing() {
  const { billing, refreshBilling, toast } = useStore();
  const { query } = useLocation();
  const account = useApi<Account>("/billing/account");
  const plans = useApi<{ plans: PlanRow[]; packs: { id: string; credits: number; priceUsd: number }[] }>("/onboarding/plans");
  const [period, setPeriod] = useState<"monthly" | "yearly">("monthly");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(query.get("checkout") === "success");
  const start = useRef(billing ? `${billing.wallet.plan.id}:${billing.wallet.purchasedBalance}` : "");

  const w = billing?.wallet;
  const canManage = billing?.payments?.canManage !== false;
  const enabled = billing?.payments?.enabled === true;
  const paid = Boolean(w && w.plan.id !== "free");
  const sub = account.data?.subscription;
  const card = account.data?.paymentMethod;

  // Jump to #plans / #credits / #invoices.
  useEffect(() => {
    const id = location.hash.slice(1);
    if (id) window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  }, []);

  // Back from checkout: the webhook grants the purchase; wait for it to land.
  useEffect(() => {
    if (!confirming) return;
    let n = 0;
    const t = window.setInterval(async () => {
      n++;
      await refreshBilling();
      account.reload();
      if (n >= 20) { window.clearInterval(t); setConfirming(false); }
    }, 3000);
    return () => window.clearInterval(t);
  }, [confirming]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!confirming || !w) return;
    const now = `${w.plan.id}:${w.purchasedBalance}`;
    if (start.current && now !== start.current) { setConfirming(false); toast("Payment confirmed — your account is updated."); navigate("/billing", { replace: true }); }
    if (!start.current) start.current = now;
  }, [w, confirming, toast]);

  const checkout = async (body: Record<string, unknown>, key: string) => {
    setBusy(key);
    try {
      const r = await api<{ url: string }>("/billing/checkout", { method: "POST", body: { ...body, returnTo: "portal" } });
      location.href = r.url;
    } catch (err: any) { toast(err.message); setBusy(null); }
  };
  const portal = async () => {
    setBusy("portal");
    try { const r = await api<{ url: string }>("/billing/portal", { method: "POST", body: { returnTo: "portal" } }); location.href = r.url; }
    catch (err: any) { toast(err.message); setBusy(null); }
  };

  if (!w) return <div className="empty">Loading billing…</div>;
  const renewal = sub?.currentPeriodEnd ?? w.subscription?.cycleEnd ?? null;
  const status = paid ? (sub?.status ?? w.subscription?.status ?? "active") : "free";
  const order = (plans.data?.plans ?? []).map((p) => p.id);

  return (
    <div className="page">
      <div className="page-head"><div><h1 className="page-title">Billing</h1>
      <p className="page-sub">Your plan, credits and invoices. Payments are handled securely by Stripe.</p></div></div>
      {query.get("checkout") === "cancel" ? <div className="notice notice--warn">Checkout was cancelled — nothing was charged.</div> : null}
      {confirming ? <div className="notice" data-testid="checkout-confirming">Confirming your payment… your plan or credits appear here as soon as it clears.</div> : null}
      {!canManage ? <div className="notice notice--warn">Only an owner or admin of this workspace can change billing.</div> : null}

      <div className="two">
        <section className="card card--pad" data-testid="plan-summary">
          <div className="card__head"><Icon.crown size={24} /><h3>{w.plan.label} plan</h3><span className={`tag ${status === "active" || status === "trialing" ? "tag--paid" : status === "free" ? "tag--muted" : "tag--open"}`}>{status === "free" ? "Free" : status.replace(/_/g, " ")}</span></div>
          <dl className="kv">
            <dt>Price</dt><dd>{paid ? w.plan.priceLabel : "$0"}</dd>
            <dt>{sub?.cancelAtPeriodEnd ? "Ends on" : "Renews on"}</dt><dd>{paid ? date(renewal) : "—"}</dd>
            <dt>Monthly credits</dt><dd>{num(w.windows.cycle.limit)}</dd>
            <dt>Included left</dt><dd>{num(w.includedBalance)}</dd>
            <dt>Top-up balance</dt><dd>{num(w.purchasedBalance)}</dd>
          </dl>
          {sub?.cancelAtPeriodEnd ? <div className="notice notice--warn" style={{ marginTop: 12 }}>Your subscription is set to end on {date(renewal)}.</div> : null}
          {status === "past_due" || status === "unpaid" ? <div className="notice notice--warn" style={{ marginTop: 12 }}>Your last payment didn't go through. Update your payment method to keep your plan.</div> : null}
        </section>
        <section className="card card--pad">
          <div className="card__head"><Icon.billing size={24} /><h3>Payment method</h3></div>
          {card ? <p style={{ fontSize: 16 }}><b style={{ textTransform: "capitalize" }}>{card.brand}</b> •••• {card.last4} <span className="muted">· expires {String(card.expMonth).padStart(2, "0")}/{card.expYear}</span></p>
            : <p className="muted">{account.loading ? "Loading…" : "No card on file yet. One is saved when you buy a plan or credits."}</p>}
          <div className="row">
            <button className="btn" onClick={() => void portal()} disabled={!enabled || !canManage || busy !== null}>{busy === "portal" ? "Opening…" : "Manage billing"}</button>
            <span className="muted" style={{ fontSize: 12.5 }}>Update card, download receipts, cancel.</span>
          </div>
        </section>
      </div>

      <StatCards w={w} />

      <section className="card card--pad" id="plans" style={{ marginTop: 4 }}>
        <div className="card__head">
          <h3>Plans</h3>
          <div className="seg" style={{ marginLeft: "auto" }}>
            <button className={period === "monthly" ? "is-on" : ""} onClick={() => setPeriod("monthly")}>Monthly</button>
            <button className={period === "yearly" ? "is-on" : ""} onClick={() => setPeriod("yearly")}>Yearly · save ~2 months</button>
          </div>
        </div>
        <div className="plans">
          {(plans.data?.plans ?? []).map((p) => {
            const current = p.id === w.plan.id;
            const up = order.indexOf(p.id) > order.indexOf(w.plan.id);
            const price = period === "yearly" && p.priceAnnualUsd ? `$${Math.round(p.priceAnnualUsd)}` : p.priceMonthlyUsd === 0 ? "$0" : `$${p.priceMonthlyUsd}`;
            return (
              <div key={p.id} className={`card plan${current ? " is-current" : ""}`} data-testid={`plan-${p.id}`}>
                <b>{p.label}</b>
                <div className="plan__price">{price}<small>{p.priceMonthlyUsd ? (period === "yearly" ? " / year" : " / month") : ""}</small></div>
                <ul>
                  <li>{num(p.monthlyCredits)} credits / month</li>
                  <li>{num(p.rolling5h)} per 5 hours · {num(p.rolling7d)} per 7 days</li>
                  <li>{p.parallelAgents} parallel agent{p.parallelAgents === 1 ? "" : "s"}</li>
                  <li>{p.features.premiumModels === "full" ? "All ORVYN models" : p.features.premiumModels === "limited" ? "Most ORVYN models" : "Core ORVYN models"}</li>
                  {p.features.teamSeats ? <li>{p.features.teamSeats} team seats</li> : null}
                </ul>
                {current ? <button className="btn" disabled>Current plan</button>
                  : p.priceMonthlyUsd === 0 ? <button className="btn" disabled={!paid || !enabled || !canManage || busy !== null} onClick={() => void portal()} title="Cancel your subscription in the billing portal">Downgrade</button>
                  : paid ? <button className="btn" disabled={!enabled || !canManage || busy !== null} onClick={() => void portal()}>{up ? "Upgrade" : "Downgrade"}</button>
                  : <button className="btn btn--primary" disabled={!enabled || !canManage || busy !== null} onClick={() => void checkout({ planId: p.id, period }, p.id)} data-testid={`buy-${p.id}`}>{busy === p.id ? "Opening checkout…" : "Upgrade"}</button>}
              </div>
            );
          })}
        </div>
        {!enabled ? <p className="muted" style={{ marginTop: 10 }}>Online purchases aren't switched on for this server yet.</p> : paid ? <p className="muted" style={{ marginTop: 10 }}>Plan changes on an active subscription are made in the billing portal and prorated by Stripe.</p> : null}
      </section>

      <div className="two" style={{ marginTop: 16 }}>
        <section className="card card--pad" id="credits">
          <div className="card__head"><Icon.coins size={24} /><h3>Buy credits</h3><span className="muted">Top-ups never expire</span></div>
          <div className="plans" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
            {(billing?.payments?.packs ?? []).map((p) => (
              <div key={p.id} className="card plan" data-testid={`pack-${p.id}`}>
                <b>{num(p.credits)} credits</b>
                <div className="plan__price">{money(p.priceUsd)}</div>
                <button className="btn btn--sm btn--primary" disabled={!p.available || !canManage || busy !== null} onClick={() => void checkout({ packId: p.id }, p.id)}>{busy === p.id ? "Opening…" : p.available ? "Buy" : "Unavailable"}</button>
              </div>
            ))}
          </div>
        </section>
        <AutoRecharge canManage={canManage} hasCard={Boolean(card)} />
      </div>

      <section className="card card--pad" id="invoices" style={{ marginTop: 16 }}>
        <div className="card__head"><h3>Invoices</h3></div>
        {account.data?.invoices.length ? (
          <table className="table" data-testid="invoices">
            <thead><tr><th>Date</th><th>Description</th><th>Amount</th><th>Status</th><th /></tr></thead>
            <tbody>{account.data.invoices.map((inv) => (
              <tr key={inv.id}>
                <td>{date(inv.date)}</td><td>{inv.description}</td><td>{money(inv.amountUsd)}</td>
                <td><span className={`tag ${inv.status === "paid" ? "tag--paid" : "tag--open"}`}>{inv.status === "paid" ? "Paid" : inv.status}</span></td>
                <td style={{ textAlign: "right" }}>{inv.hostedUrl ? <a href={inv.hostedUrl} target="_blank" rel="noopener noreferrer">View</a> : null}{inv.pdfUrl ? <> · <a href={inv.pdfUrl} target="_blank" rel="noopener noreferrer">PDF</a></> : null}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : <div className="list__empty">{account.error ? "Invoices aren't available right now." : "No invoices yet."}</div>}
      </section>
    </div>
  );
}

function AutoRecharge({ canManage, hasCard }: { canManage: boolean; hasCard: boolean }) {
  const { billing, refreshBilling, toast } = useStore();
  const ar = billing?.wallet.autoRecharge ?? null;
  const packs = billing?.payments?.packs ?? [];
  const [packId, setPackId] = useState(ar?.pack_id ?? packs[0]?.id ?? "pack_10k");
  const [threshold, setThreshold] = useState(ar?.threshold ?? 500);
  const [max, setMax] = useState(ar?.max_per_month ?? 3);
  const [saving, setSaving] = useState(false);
  const save = async (enabled: boolean) => {
    setSaving(true);
    try {
      await api("/billing/auto-recharge", { method: "POST", body: enabled ? { packId, threshold, maxPerMonth: max } : { enabled: false } });
      await refreshBilling();
      toast(enabled ? "Auto-recharge is on." : "Auto-recharge is off.");
    } catch (err: any) { toast(err.message); } finally { setSaving(false); }
  };
  return (
    <section className="card card--pad" data-testid="auto-recharge">
      <div className="card__head"><Icon.spark size={24} /><h3>Auto-recharge</h3><span className={`tag ${ar ? "tag--paid" : "tag--muted"}`}>{ar ? "On" : "Off"}</span></div>
      <p className="muted" style={{ marginTop: 0 }}>When your balance drops below the threshold, ORVYN buys a credit pack with your saved card.{ar ? ` ${ar.recharges_this_cycle} of ${ar.max_per_month} used this month.` : ""}</p>
      <div className="two" style={{ gap: 10 }}>
        <div className="field"><label htmlFor="ar-pack">Pack</label>
          <select id="ar-pack" className="input select" value={packId} onChange={(e) => setPackId(e.target.value)}>
            {packs.map((p) => <option key={p.id} value={p.id}>{num(p.credits)} credits · {money(p.priceUsd)}</option>)}
          </select></div>
        <div className="field"><label htmlFor="ar-th">When balance is below</label><input id="ar-th" className="input" type="number" min={0} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} /></div>
        <div className="field"><label htmlFor="ar-max">At most per month</label><input id="ar-max" className="input" type="number" min={1} max={20} value={max} onChange={(e) => setMax(Number(e.target.value))} /></div>
      </div>
      {!hasCard ? <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>Needs a saved card — buy a plan or credits once first.</div> : null}
      <div className="row">
        <button className="btn btn--primary" disabled={!canManage || saving} onClick={() => void save(true)}>{ar ? "Save" : "Turn on"}</button>
        {ar ? <button className="btn" disabled={!canManage || saving} onClick={() => void save(false)}>Turn off</button> : null}
      </div>
    </section>
  );
}
