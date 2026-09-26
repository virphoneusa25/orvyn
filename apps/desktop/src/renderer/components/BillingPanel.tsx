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

export function BillingPanel() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch(apiUrl("/billing"), { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => setWallet(d.wallet ?? null))
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function post(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(apiUrl(path), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Request failed");
      setWallet(d.wallet);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: 20 }}>
      <div style={{ fontSize: 18, fontWeight: 700 }}>Usage</div>
      <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)", marginTop: 4, marginBottom: 16 }}>
        Credits are the usage unit. Included credits reset each billing cycle. Purchased credits stay until you spend them.
      </div>
      {error && <div style={{ color: "#e06c75", fontSize: 12, marginBottom: 10 }}>{error}</div>}
      {!wallet && !error && <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)" }}>Loading balance…</div>}
      {wallet && (
        <>
          <div style={card}>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{wallet.availableBalance.toLocaleString()}</div>
            <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)" }}>credits available · {wallet.plan.label} {wallet.plan.priceLabel}</div>
            <div style={{ fontSize: 12, marginTop: 8 }}>
              Included {wallet.includedBalance.toLocaleString()} · Purchased {wallet.purchasedBalance.toLocaleString()} · Held for active runs {wallet.reservedBalance.toLocaleString()}
            </div>
          </div>
          <div style={card}>
            <Bar label="5-hour usage" used={wallet.windows.fiveHour.used} limit={wallet.windows.fiveHour.limit} />
            <Bar label="7-day usage" used={wallet.windows.sevenDay.used} limit={wallet.windows.sevenDay.limit} />
            <Bar label="Billing cycle" used={wallet.windows.cycle.used} limit={wallet.windows.cycle.limit} />
          </div>
          <div style={card}>
            <b>Add credits</b>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
              {wallet.packs.map((p) => (
                <button key={p.id} disabled={busy} onClick={() => void post("/billing/topup", { packId: p.id })} style={btn}>
                  {p.credits.toLocaleString()} · ${p.priceUsd}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", marginTop: 8 }}>{wallet.note}</div>
          </div>
          <div style={card}>
            <b>Plan</b>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              {["starter", "pro", "team"].map((id) => (
                <button key={id} disabled={busy || wallet.plan.id === id} onClick={() => void post("/billing/plan", { planId: id })} style={btn}>
                  {id}
                </button>
              ))}
            </div>
          </div>
          <div style={card}>
            <b>Auto-recharge</b>
            <div style={{ fontSize: 12, marginTop: 6, color: "var(--orvyn-text-muted)" }}>
              {wallet.autoRecharge
                ? `Buys ${wallet.autoRecharge.pack_id} below ${wallet.autoRecharge.threshold} credits. ${wallet.autoRecharge.recharges_this_cycle}/${wallet.autoRecharge.max_per_month} used this cycle.`
                : "Off. The default is 5,000 credits when the balance falls below 500, at most 3 times a month."}
            </div>
            <button disabled={busy} style={{ ...btn, marginTop: 8 }} onClick={() => void post("/billing/auto-recharge", { threshold: 500, packId: "pack_5k", maxPerMonth: 3 })}>
              Turn on default auto-recharge
            </button>
          </div>
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
