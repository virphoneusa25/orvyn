import { useMemo, useState } from "react";
import { num } from "../lib/format";
import { navigate } from "../lib/router";
import { useStore } from "../lib/store";
import { useApi } from "../lib/useApi";
import { dailyPoints, type Stats } from "../lib/usage";
import { Bar } from "../components/Bits";
import { UsageChart } from "../components/UsageChart";

function resetIn(ts: number): string {
  const ms = Math.max(0, ts - Date.now());
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000);
  return h >= 48 ? `${Math.round(h / 24)} days` : h ? `${h}h ${m}m` : `${m}m`;
}

export function Usage() {
  const { billing } = useStore();
  const { data } = useApi<Stats & { windows?: unknown }>("/billing/stats");
  const [range, setRange] = useState<7 | 30>(7);
  const w = billing?.wallet;
  const byModel = useMemo(() => {
    const out = new Map<string, number>();
    const since = new Date(Date.now() - range * 86_400_000).toISOString().slice(0, 10);
    for (const d of data?.days ?? []) {
      if (d.day < since) continue;
      for (const [k, v] of Object.entries(d.models)) out.set(k, (out.get(k) ?? 0) + v.credits);
    }
    return [...out.entries()].sort((a, b) => b[1] - a[1]);
  }, [data, range]);
  const total = byModel.reduce((s, [, v]) => s + v, 0);

  return (
    <>
      <h1 className="page-title">Usage</h1>
      <p className="page-sub">Credits used across ORVYN Cloud and ORVYN Desktop — one account, one balance.</p>
      {w ? (
        <div className="three">
          {([["Monthly credits", w.windows.cycle, `Resets in ${resetIn(w.windows.cycle.resetAt)}`], ["5-hour window", w.windows.fiveHour, `Frees up in ${resetIn(w.windows.fiveHour.resetAt)}`], ["7-day window", w.windows.sevenDay, `Frees up in ${resetIn(w.windows.sevenDay.resetAt)}`]] as const).map(([label, win, foot]) => (
            <section key={label} className="card card--pad" data-testid="usage-window">
              <div className="stat__label">{label}</div>
              <div className="big">{num(win.used)} <small className="muted" style={{ fontSize: 15 }}>/ {num(win.limit)}</small></div>
              <Bar used={win.used} limit={win.limit} />
              <div className="stat__foot" style={{ marginTop: 6 }}>{foot}</div>
            </section>
          ))}
        </div>
      ) : null}
      <div className="two" style={{ marginTop: 16, gridTemplateColumns: "minmax(0,2fr) minmax(0,1fr)" }}>
        <section className="card card--pad">
          <div className="card__head">
            <h3>Credits per day</h3>
            <div className="seg" style={{ marginLeft: "auto" }}>
              <button className={range === 7 ? "is-on" : ""} onClick={() => setRange(7)}>7 days</button>
              <button className={range === 30 ? "is-on" : ""} onClick={() => setRange(30)}>30 days</button>
            </div>
          </div>
          <UsageChart points={dailyPoints(data ?? null, range)} height={220} />
        </section>
        <section className="card card--pad">
          <div className="card__head"><h3>By model</h3><span className="muted">last {range} days</span></div>
          {byModel.length ? byModel.map(([name, credits]) => (
            <div key={name} style={{ marginBottom: 12 }}>
              <div className="spread"><span>{name}</span><span className="muted">{num(credits)} credits</span></div>
              <Bar used={credits} limit={total || 1} />
            </div>
          )) : <div className="list__empty">No usage yet.</div>}
        </section>
      </div>
      {w ? (
        <section className="card card--pad" style={{ marginTop: 16 }}>
          <div className="spread">
            <div><b>Balance</b><div className="muted">{num(w.includedBalance)} included this month · {num(w.purchasedBalance)} top-up · {num(w.availableBalance)} available</div></div>
            <div className="row"><button className="btn" onClick={() => navigate("/billing#credits")}>Buy credits</button><button className="btn btn--primary" onClick={() => navigate("/billing#plans")}>Upgrade</button></div>
          </div>
        </section>
      ) : null}
    </>
  );
}
