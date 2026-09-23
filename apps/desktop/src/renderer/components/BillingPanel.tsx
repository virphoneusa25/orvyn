import React, { useEffect, useState } from "react";
import { apiUrl, authHeaders } from "../connection";

export function BillingPanel() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(apiUrl("/billing"), { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((err) => {
        if (alive) setError(err.message);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: 20 }}>
      <div style={{ fontSize: 18, fontWeight: 700 }}>Billing</div>
      <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)", marginTop: 4, marginBottom: 16 }}>
        Usage is metered. Stripe is not wired — this is the BillingProvider / entitlement layer, not a checkout page.
      </div>
      {error && <div style={{ color: "var(--orvyn-text-muted)", fontSize: 12 }}>Billing API unavailable: {error}</div>}
      {data && (
        <>
          <div style={card}>
            <b>Provider</b>
            <div style={{ marginTop: 6 }}>{data.provider} — {data.note}</div>
          </div>
          <div style={card}>
            <b>Account limits</b>
            <pre style={{ margin: "8px 0 0", fontSize: 12 }}>{JSON.stringify(data.entitlements, null, 2)}</pre>
          </div>
          <div style={card}>
            <b>Used this cycle</b>
            <pre style={{ margin: "8px 0 0", fontSize: 12 }}>{JSON.stringify(data.used, null, 2)}</pre>
          </div>
          <div style={card}>
            <b>Estimated model + execution cost</b>
            <div style={{ marginTop: 6 }}>
              ${Number(data.cost?.estimatedCost ?? 0).toFixed(6)} estimated · ${Number(data.cost?.executionCost ?? 0).toFixed(6)} execution
            </div>
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
