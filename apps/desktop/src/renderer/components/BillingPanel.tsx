import React, { useCallback, useEffect, useState } from "react";
import { apiUrl, authHeaders } from "../connection";

interface Wallet {
  plan: { id: string; label: string; priceLabel: string };
  includedBalance: number;
  purchasedBalance: number;
  reservedBalance: number;
  availableBalance: number;
  windows: {
    fiveHour: { used: number; limit: number };
    sevenDay: { used: number; limit: number };
    cycle: { used: number; limit: number };
  };
  packs: { id: string; credits: number; priceUsd: number }[];
  autoRecharge?: { threshold: number; pack_id: string; max_per_month: number; recharges_this_cycle: number } | null;
  note: string;
}

function Bar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
        <span>{label}</span>
        <span style={{ color: "var(--orvyn-text-muted)" }}>{used.toLocaleString()} / {limit.toLocaleString()}</span>
      </div>
      <div style={{ height: 8, borderRadius: 99, background: "var(--orvyn-border-soft)", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: "var(--orvyn-purple, #6C5CFF)" }} />
      </div>
    </div>
  );
}

const PLAN_CHOICES = [
  { id: "starter", label: "Starter", monthly: 29, yearly: 290 },
  { id: "pro", label: "Pro", monthly: 59, yearly: 590 },
  { id: "power", label: "Power", monthly: 99, yearly: 990 },
  { id: "business", label: "Business", monthly: 199, yearly: 1990 },
  { id: "team", label: "Team", monthly: 399, yearly: 3990 },
];

interface Payments { enabled: boolean; canManage: boolean; packs: { id: string; credits: number; priceUsd: number; available: boolean }[] }

export function BillingPanel() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [payments, setPayments] = useState<Payments | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [yearly, setYearly] = useState(false);

  const load = useCallback(async (): Promise<Wallet | null> => {
    try {
      const d = await fetch(apiUrl("/billing"), { headers: authHeaders() }).then((r) => r.json());
      setWallet(d.wallet ?? null);
      setPayments(d.payments ?? null);
      return d.wallet ?? null;
    } catch (err: any) {
      setError(err.message);
      return null;
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function post(path: string, body: unknown): Promise<any> {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(apiUrl(path), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Request failed");
      if (d.wallet) setWallet(d.wallet);
      return d;
    } catch (err: any) {
      setError(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  /** Checkout opens in the browser; the balance changes only when Stripe confirms the payment. */
  async function buy(body: { planId?: string; packId?: string; period?: string }) {
    const d = await post("/billing/checkout", body);
    if (!d?.url) return;
    void window.orvyn.window.openExternal?.(d.url);
    setInfo("Checkout opened in your browser. Your balance updates here as soon as the payment is confirmed.");
    const before = JSON.stringify([wallet?.plan.id, wallet?.purchasedBalance, wallet?.includedBalance]);
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const w = await load();
      if (w && JSON.stringify([w.plan.id, w.purchasedBalance, w.includedBalance]) !== before) { setInfo("Payment confirmed — your balance is updated."); return; }
    }
  }

  async function portal() {
    const d = await post("/billing/portal", {});
    if (d?.url) void window.orvyn.window.openExternal?.(d.url);
  }

  const canBuy = Boolean(payments?.enabled && payments?.canManage);

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: 20 }}>
      <div style={{ fontSize: 18, fontWeight: 700 }}>Billing & usage</div>
      <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)", marginTop: 4, marginBottom: 16 }}>
        Credits are the usage unit. Included credits reset each billing cycle. Purchased credits stay until you spend them.
      </div>
      {error && <div style={{ color: "#e06c75", fontSize: 12, marginBottom: 10 }}>{error}</div>}
      {info && <div style={{ color: "var(--orvyn-text-muted)", fontSize: 12, marginBottom: 10 }} data-testid="billing-info">{info}</div>}
      {!wallet && !error && <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)" }}>Loading balance…</div>}
      {wallet && (
        <>
          <div style={card}>
            <div style={{ fontSize: 28, fontWeight: 700 }} data-testid="billing-available">{wallet.availableBalance.toLocaleString()}</div>
            <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)" }}>credits available · {wallet.plan.label} {wallet.plan.priceLabel}</div>
            <div style={{ fontSize: 12, marginTop: 8 }}>
              Included {wallet.includedBalance.toLocaleString()} · Purchased {wallet.purchasedBalance.toLocaleString()} · Held for active runs {wallet.reservedBalance.toLocaleString()}
            </div>
            {canBuy ? <button disabled={busy} style={{ ...btn, marginTop: 10 }} onClick={() => void portal()}>Manage billing & invoices</button> : null}
          </div>
          <div style={card}>
            <Bar label="5-hour usage" used={wallet.windows.fiveHour.used} limit={wallet.windows.fiveHour.limit} />
            <Bar label="7-day usage" used={wallet.windows.sevenDay.used} limit={wallet.windows.sevenDay.limit} />
            <Bar label="Billing cycle" used={wallet.windows.cycle.used} limit={wallet.windows.cycle.limit} />
          </div>
          {!payments?.enabled ? (
            <div style={card}><b>Plans and credits</b><div style={{ fontSize: 12, marginTop: 6, color: "var(--orvyn-text-muted)" }}>Purchases aren't available on this server yet.</div></div>
          ) : !payments.canManage ? (
            <div style={card}><b>Plans and credits</b><div style={{ fontSize: 12, marginTop: 6, color: "var(--orvyn-text-muted)" }}>Ask an owner or admin of this organization to change billing.</div></div>
          ) : (
            <>
              <div style={card}>
                <b>Add credits</b>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
                  {payments.packs.filter((p) => p.available).map((p) => (
                    <button key={p.id} disabled={busy} onClick={() => void buy({ packId: p.id })} style={btn}>
                      {p.credits.toLocaleString()} · ${p.priceUsd}
                    </button>
                  ))}
                  {!payments.packs.some((p) => p.available) ? <span style={{ fontSize: 12, color: "var(--orvyn-text-muted)" }}>Credit packs aren't on sale yet.</span> : null}
                </div>
              </div>
              <div style={card}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <b>Plan</b>
                  <label style={{ fontSize: 12 }}><input type="checkbox" checked={yearly} onChange={(e) => setYearly(e.target.checked)} /> Yearly (≈2 months free)</label>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
                  {PLAN_CHOICES.map((p) => (
                    <button key={p.id} disabled={busy || wallet.plan.id === p.id} onClick={() => void buy({ planId: p.id, period: yearly ? "yearly" : "monthly" })} style={btn}>
                      {p.label} · ${yearly ? `${p.yearly}/yr` : `${p.monthly}/mo`}
                    </button>
                  ))}
                </div>
              </div>
              <div style={card}>
                <b>Auto-recharge</b>
                <div style={{ fontSize: 12, marginTop: 6, color: "var(--orvyn-text-muted)" }}>
                  {wallet.autoRecharge
                    ? `Charges your saved card for ${wallet.autoRecharge.pack_id.replace("pack_", "").toUpperCase()} credits when the balance falls below ${wallet.autoRecharge.threshold.toLocaleString()}. ${wallet.autoRecharge.recharges_this_cycle}/${wallet.autoRecharge.max_per_month} used this cycle.`
                    : "Off. Turn it on to buy 10,000 credits ($10) with your saved card when the balance falls below 500 — at most 3 times a month."}
                </div>
                {wallet.autoRecharge
                  ? <button disabled={busy} style={{ ...btn, marginTop: 8 }} onClick={() => void post("/billing/auto-recharge", { enabled: false })}>Turn off</button>
                  : <button disabled={busy} style={{ ...btn, marginTop: 8 }} onClick={() => void post("/billing/auto-recharge", { threshold: 500, packId: "pack_10k", maxPerMonth: 3 })}>Turn on auto-recharge</button>}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

const card: React.CSSProperties = {
  padding: "12px 14px",
  border: "1px solid var(--orvyn-border-soft)",
  borderRadius: 8,
  background: "var(--orvyn-surface-2)",
  marginBottom: 10,
  fontSize: 13,
};

const btn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--orvyn-border)",
  borderRadius: 8,
  color: "inherit",
  padding: "6px 10px",
  cursor: "pointer",
  fontSize: 12,
};
