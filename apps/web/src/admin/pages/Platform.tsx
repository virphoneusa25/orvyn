import { useState } from "react";
import { useQuery } from "../query";
import { fmtNum, fmtUsd } from "../format";
import { A } from "../components/AIcons";
import { Card, Empty, ErrorBox, SkeletonRows, Toggle } from "../components/UI";

const yes = (b: boolean) => (b ? <span className="a-badge a-badge--active">Configured</span> : <span className="a-badge a-badge--past_due">Missing</span>);

export function Plans() {
  const q = useQuery<{ plans: { id: string; label: string; public: boolean; priceMonthlyUsd: number | null; priceAnnualUsd: number | null; monthlyCredits: number; rolling5h: number; rolling7d: number; parallelAgents: number; features: { premiumModels: string; teamSeats: number; priority: string; apiAccess: boolean }; stripe: { monthly: boolean; yearly: boolean }; customers: number; mrr: number }[]; note: string }>("/admin/plans");
  return (
    <Card title="Plans" sub={q.data?.note}>
      <ErrorBox error={q.error} retry={q.reload} />
      {!q.data ? <SkeletonRows rows={7} /> : (
        <div className="a-table-wrap"><table className="a-table" data-testid="plans-table">
          <thead><tr><th>Plan</th><th className="num">Monthly</th><th className="num">Annual</th><th className="num">Credits / mo</th><th className="num">5 h / 7 d</th><th>Models</th><th className="num">Agents</th><th>Stripe monthly</th><th>Stripe annual</th><th className="num">Customers</th><th className="num">MRR</th></tr></thead>
          <tbody>{q.data.plans.map((p) => (
            <tr key={p.id} style={{ cursor: "default" }}>
              <td><b>{p.label}</b>{!p.public ? <small>{p.id === "free" ? "Internal $0" : "Not self-serve"}</small> : null}</td>
              <td className="num">{p.priceMonthlyUsd === null ? "Custom" : fmtUsd(p.priceMonthlyUsd, 0)}</td><td className="num">{p.priceAnnualUsd ? fmtUsd(p.priceAnnualUsd, 0) : "—"}</td>
              <td className="num">{fmtNum(p.monthlyCredits)}{p.id === "team" ? <small>pooled</small> : null}</td><td className="num">{fmtNum(p.rolling5h)} / {fmtNum(p.rolling7d)}</td>
              <td style={{ textTransform: "capitalize" }}>{p.features.premiumModels}</td><td className="num">{p.parallelAgents}</td>
              <td>{p.priceMonthlyUsd ? yes(p.stripe.monthly) : "—"}</td><td>{p.priceAnnualUsd ? yes(p.stripe.yearly) : "—"}</td>
              <td className="num">{fmtNum(p.customers)}</td><td className="num">{fmtUsd(p.mrr)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </Card>
  );
}

export function Topups() {
  const [days, setDays] = useState(30);
  const q = useQuery<{ packs: { id: string; credits: number; priceUsd: number; available: boolean; sales: { purchases: number; credits: number; revenueUsd: number } }[] }>(`/admin/topups?days=${days}`);
  return (
    <Card title="Credit packs" action={<div className="a-seg" style={{ marginLeft: "auto" }}>{[30, 90, 365].map((d) => <button key={d} className={days === d ? "is-on" : ""} onClick={() => setDays(d)}>{d} days</button>)}</div>}>
      <ErrorBox error={q.error} retry={q.reload} />
      {!q.data ? <SkeletonRows rows={6} /> : (
        <table className="a-table"><thead><tr><th>Pack</th><th className="num">Price</th><th className="num">$ / 1K</th><th>Stripe price</th><th className="num">Purchases</th><th className="num">Credits sold</th><th className="num">Revenue</th></tr></thead>
          <tbody>{q.data.packs.map((p) => <tr key={p.id} style={{ cursor: "default" }}><td><b>{fmtNum(p.credits)} credits</b><small className="a-mono">STRIPE_PRICE_{p.id.toUpperCase()}</small></td><td className="num">{fmtUsd(p.priceUsd, 0)}</td><td className="num">{fmtUsd((p.priceUsd / p.credits) * 1000)}</td><td>{yes(p.available)}</td><td className="num">{fmtNum(p.sales.purchases)}</td><td className="num">{fmtNum(p.sales.credits)}</td><td className="num">{fmtUsd(p.sales.revenueUsd)}</td></tr>)}</tbody></table>
      )}
      {q.data && !q.data.packs.some((p) => p.sales.purchases) ? <Empty icon="topup" title={`No top-ups in the last ${days} days`} /> : null}
    </Card>
  );
}

export function Flags() {
  const q = useQuery<{ flags: { key: string; label: string; on: boolean; description: string }[] }>("/admin/flags");
  return (
    <Card title="Runtime switches" sub="Set by the deployment's configuration (changing one needs a config change and redeploy)">
      <ErrorBox error={q.error} retry={q.reload} />
      {!q.data ? <SkeletonRows /> : q.data.flags.map((f) => (
        <div key={f.key} className="a-feed__row"><Toggle on={f.on} label={f.label} /><span><b>{f.label}</b><small className="muted" style={{ display: "block" }}>{f.description}</small></span><time className="a-mono">{f.key}</time></div>
      ))}
    </Card>
  );
}

export function Integrations() {
  const q = useQuery<{ integrations: { id: string; name: string; status: string; detail: string; missing?: string[] }[] }>("/admin/integrations");
  return (
    <div className="a-grid3" style={{ marginTop: 0 }}>
      <ErrorBox error={q.error} retry={q.reload} />
      {!q.data ? <SkeletonRows rows={3} h={100} /> : q.data.integrations.map((i) => (
        <Card key={i.id} title={i.name} action={<span style={{ marginLeft: "auto" }} className={`a-badge ${i.status === "connected" ? "a-badge--active" : i.status === "error" ? "a-badge--cancelled" : "a-badge--past_due"}`}>{i.status === "connected" ? "Connected" : i.status === "error" ? "Error" : "Not configured"}</span>}>
          <p className="muted" style={{ margin: 0 }}>{i.detail}</p>
          {i.missing?.length ? <details style={{ marginTop: 8 }}><summary className="muted" style={{ cursor: "pointer", fontSize: 12.5 }}>{i.missing.length} price variable{i.missing.length === 1 ? "" : "s"} not set</summary><div className="a-mono" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.7 }}>{i.missing.map((m) => <div key={m}>{m}</div>)}</div></details> : null}
        </Card>
      ))}
    </div>
  );
}

export function EmailTemplates() {
  const q = useQuery<{ templates: { id: string; name: string; trigger: string; subject: string }[]; mail: string }>("/admin/email-templates");
  const [sel, setSel] = useState<string | null>(null);
  const t = useQuery<{ subject: string; html: string; text: string }>(sel ? `/admin/email-templates/${sel}` : null);
  return (
    <div className="a-acct-row2" style={{ marginTop: 0 }}>
      <Card title="Templates" sub={q.data?.mail === "configured" ? "Email is configured" : "Email is NOT configured — nothing is sent"}>
        <ErrorBox error={q.error} retry={q.reload} />
        {!q.data ? <SkeletonRows /> : q.data.templates.map((x) => (
          <button key={x.id} className="adm-pop__item" style={{ borderRadius: 10, background: sel === x.id ? "rgba(124,92,255,.16)" : undefined }} onClick={() => setSel(x.id)}>
            <A.mail size={18} /><span><b>{x.name}</b><small>{x.subject} · {x.trigger}</small></span>
          </button>
        ))}
      </Card>
      <Card title={t.data ? t.data.subject : "Preview"} sub="Sample data">
        {!sel ? <Empty icon="mail" title="Pick a template to preview" /> : !t.data ? <SkeletonRows rows={4} h={60} /> : <iframe className="a-email-frame" sandbox="" title="Email preview" srcDoc={t.data.html} />}
      </Card>
    </div>
  );
}
