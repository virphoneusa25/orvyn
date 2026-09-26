import React, { useCallback, useEffect, useMemo, useState } from "react";
import { apiUrl, authHeaders } from "../connection";

interface WindowRow { used: number; limit: number; resetAt?: number }
interface Part { credits: number; tokens: number }
interface DayRow {
  day: string;
  tokens: number;
  credits: number;
  cached: number;
  input: number;
  models: Record<string, Part>;
  tools: Record<string, Part>;
}
interface Stats {
  refreshedAt: number;
  plan?: { id: string; label: string; priceLabel: string };
  includedBalance?: number;
  purchasedBalance?: number;
  windows: { fiveHour: WindowRow; sevenDay: WindowRow; cycle: WindowRow };
  cache?: { cachedTokens: number; inputTokens: number };
  providers?: Record<string, number>;
  tasks?: Record<string, number>;
  activity: { totalTokens: number; peakTokens: number; durationMs: number; longestSessionMs?: number; currentStreakDays: number; longestStreakDays: number };
  days: DayRow[];
}

const SERIES = ["#60a5fa", "#a78bfa", "#34d399", "#f59e0b"];

function remaining(row?: WindowRow): number {
  if (!row || row.limit <= 0) return 1;
  return Math.max(0, Math.min(1, (row.limit - row.used) / row.limit));
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function compact(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${Math.round(abs)}`;
}

function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d} d ${h} h ${m} m`;
  if (h > 0) return `${h} h ${m} m`;
  return `${m} m`;
}

function when(ts?: number): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${date}, ${h}:${m}`;
}

function refreshed(ts?: number): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${date}, ${time}`;
}

function emptyDay(day: string): DayRow {
  return { day, tokens: 0, credits: 0, cached: 0, input: 0, models: {}, tools: {} };
}

function fillDays(days: DayRow[], range: number, end = Date.now()): DayRow[] {
  const map = new Map(days.map((d) => [d.day, d]));
  const endUtc = Date.UTC(new Date(end).getUTCFullYear(), new Date(end).getUTCMonth(), new Date(end).getUTCDate());
  const out: DayRow[] = [];
  for (let i = range - 1; i >= 0; i--) {
    const key = new Date(endUtc - i * 86_400_000).toISOString().slice(0, 10);
    out.push(map.get(key) ?? emptyDay(key));
  }
  return out;
}

function hitRate(cached: number, input: number): number | null {
  if (input <= 0 || cached <= 0) return null;
  return Math.min(1, cached / input);
}

export function UsageStatsPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"app" | "plan">("app");
  const [heat, setHeat] = useState<"daily" | "weekly" | "cumulative">("daily");
  const [range, setRange] = useState<7 | 30 | 90>(7);
  const [metric, setMetric] = useState<"credits" | "usage" | "models" | "tools">("credits");

  const load = useCallback(() => {
    setLoading(true);
    fetch(apiUrl("/billing/stats"), { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Usage stats are unavailable"))))
      .then((d) => { setStats(d); setError(null); })
      .catch((err) => setError(err instanceof Error ? err.message : "Usage stats are unavailable"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const days = stats?.days ?? [];
  const recent = useMemo(() => fillDays(days, range, stats?.refreshedAt), [days, range, stats?.refreshedAt]);
  const prior = useMemo(() => {
    const end = stats?.refreshedAt ?? Date.now();
    const endUtc = Date.UTC(new Date(end).getUTCFullYear(), new Date(end).getUTCMonth(), new Date(end).getUTCDate());
    return fillDays(days, range, endUtc - range * 86_400_000);
  }, [days, range, stats?.refreshedAt]);

  const creditsTotal = recent.reduce((n, d) => n + d.credits, 0);
  const tokenTotal = recent.reduce((n, d) => n + d.tokens, 0);
  const activeDays = recent.filter((d) => d.credits > 0 || d.tokens > 0).length;
  const avgDaily = activeDays ? creditsTotal / activeDays : 0;
  const priorCredits = prior.reduce((n, d) => n + d.credits, 0);
  const priorActive = prior.filter((d) => d.credits > 0).length;
  const priorAvg = priorActive ? priorCredits / priorActive : 0;
  const creditDelta = priorCredits > 0 ? (creditsTotal - priorCredits) / priorCredits : null;
  const avgDelta = priorAvg > 0 ? (avgDaily - priorAvg) / priorAvg : null;
  const cacheNow = hitRate(recent.reduce((n, d) => n + d.cached, 0), recent.reduce((n, d) => n + d.input, 0));
  const cachePrior = hitRate(prior.reduce((n, d) => n + d.cached, 0), prior.reduce((n, d) => n + d.input, 0));
  const cacheDelta = cacheNow !== null && cachePrior !== null ? cacheNow - cachePrior : null;

  return (
    <div className="usage-page">
      <div className="usage-page__head">
        <div className="usage-page__title">
          <h1>Usage stats</h1>
          <div className="usage-pills" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "app"} className={tab === "app" ? "is-on" : ""} onClick={() => setTab("app")}>App usage</button>
            <button type="button" role="tab" aria-selected={tab === "plan"} className={tab === "plan" ? "is-on" : ""} onClick={() => setTab("plan")}>Individual Plan</button>
          </div>
        </div>
        <div className="usage-refresh">
          Last refreshed: {refreshed(stats?.refreshedAt)}
          <button type="button" onClick={load} aria-label="Refresh" disabled={loading}>
            <Refresh />
          </button>
        </div>
      </div>
      {error && <p className="usage-error">{error}</p>}
      {loading && !stats && <p className="usage-muted">Loading usage…</p>}
      {tab === "app" ? (
        <AppUsage stats={stats} days={days} heat={heat} setHeat={setHeat} range={range} setRange={setRange} />
      ) : (
        <>
          <div className="usage-meters">
            <Meter
              icon="bolt"
              tone="blue"
              title="5-hour remaining"
              value={stats ? pct(remaining(stats.windows.fiveHour)) : "—"}
              when={when(stats?.windows.fiveHour.resetAt)}
              bar={remaining(stats?.windows.fiveHour)}
              color="linear-gradient(90deg, #2563eb, #60a5fa)"
              foot={stats ? `${Math.round(remaining(stats.windows.fiveHour) * 5)}h / 5h` : "—"}
            />
            <Meter
              icon="cal"
              tone="green"
              title="Weekly remaining"
              value={stats ? pct(remaining(stats.windows.sevenDay)) : "—"}
              when={when(stats?.windows.sevenDay.resetAt)}
              bar={remaining(stats?.windows.sevenDay)}
              color="linear-gradient(90deg, #2563eb, #38bdf8)"
              dot={stats && remaining(stats.windows.sevenDay) === 0 ? "#34d399" : undefined}
              foot={stats ? `${pct(remaining(stats.windows.sevenDay))} / 100%` : "—"}
            />
            <Meter
              icon="box"
              tone="purple"
              title="ORVYN MCP"
              value={stats ? pct(remaining(stats.windows.cycle)) : "—"}
              when={when(stats?.windows.cycle.resetAt)}
              bar={remaining(stats?.windows.cycle)}
              color="linear-gradient(90deg, #7c3aed, #c4b5fd)"
              foot={stats ? `${pct(remaining(stats.windows.cycle))} / 100%` : "—"}
            />
          </div>

          <h2>Activity</h2>
          <div className="usage-activity">
            <Stat icon="doc" tone="blue" value={compact(stats?.activity.totalTokens ?? 0)} label="Total tokens" />
            <Stat icon="bars" tone="purple" value={compact(stats?.activity.peakTokens ?? 0)} label="Peak tokens" hint="Largest single model call" />
            <Stat icon="clock" tone="cyan" value={duration(stats?.activity.durationMs ?? 0)} label="Total usage duration" />
            <Stat icon="flame" tone="orange" value={`${stats?.activity.currentStreakDays ?? 0} d`} label="Current streak" />
            <Stat icon="trophy" tone="amber" value={`${stats?.activity.longestStreakDays ?? 0} d`} label="Longest streak" />
          </div>

          <section className="usage-card">
            <div className="usage-card__top">
              <b>Token activity</b>
              <div className="usage-pills">
                {(["daily", "weekly", "cumulative"] as const).map((id) => (
                  <button key={id} type="button" className={heat === id ? "is-on" : ""} onClick={() => setHeat(id)}>{id[0].toUpperCase() + id.slice(1)}</button>
                ))}
              </div>
            </div>
            <Heatmap days={days} mode={heat} />
          </section>

          <section className="usage-card">
            <div className="usage-card__top">
              <b>Usage trends</b>
              <div className="usage-pills">
                {([7, 30, 90] as const).map((n) => (
                  <button key={n} type="button" className={range === n ? "is-on" : ""} onClick={() => setRange(n)}>{n} days</button>
                ))}
              </div>
            </div>
            <div className="usage-trends">
              <Trend
                icon="db"
                label="Cache hit rate"
                value={cacheNow === null ? "—" : pct(cacheNow)}
                delta={cacheDelta}
                series={recent.map((d) => hitRate(d.cached, d.input) ?? 0)}
                color="#f87171"
              />
              <Trend icon="coin" label="Credits total" value={compact(creditsTotal)} delta={creditDelta} series={recent.map((d) => d.credits)} color="#60a5fa" />
              <Trend icon="bars" label="Average daily credits" value={compact(avgDaily)} delta={avgDelta} series={recent.map((d) => d.credits)} color="#c4b5fd" />
            </div>
          </section>

          <section className="usage-card">
            <div className="usage-pills" style={{ marginBottom: 12 }}>
              {(["credits", "usage", "models", "tools"] as const).map((id) => (
                <button key={id} type="button" className={metric === id ? "is-on" : ""} onClick={() => setMetric(id)}>{id[0].toUpperCase() + id.slice(1)}</button>
              ))}
            </div>
            <BarChart
              days={recent}
              metric={metric}
              totalLabel={metric === "usage" ? `${compact(tokenTotal)} tokens` : `${compact(creditsTotal)} credits`}
            />
          </section>

          <section className="usage-card">
            <div className="usage-card__top">
              <b>System health</b>
              <span className="usage-muted">Last 7 days</span>
            </div>
            <Health days={fillDays(days, 7, stats?.refreshedAt)} />
          </section>
        </>
      )}
    </div>
  );
}

const MODEL_COLORS = ["#3b82f6", "#a78bfa", "#34d399", "#fb923c", "#f87171", "#22d3ee"];
const TASKS: { name: string; icon: string; color: string }[] = [
  { name: "General chat", icon: "chat", color: "#a78bfa" },
  { name: "Coding & development", icon: "code", color: "#60a5fa" },
  { name: "Research & analysis", icon: "search", color: "#34d399" },
  { name: "Content creation", icon: "pen", color: "#fb923c" },
  { name: "Data analysis", icon: "db", color: "#22d3ee" },
  { name: "Other", icon: "dots", color: "#94a3b8" },
];

function providerLabel(id: string): string {
  const key = id.toLowerCase();
  if (key === "orvyn" || key === "default") return "ORVYN";
  if (key === "anthropic") return "Anthropic";
  if (key === "openai") return "OpenAI";
  if (key === "other" || key === "others") return "Others";
  return id;
}

function shareLabel(n: number, total: number): string {
  if (total <= 0 || n <= 0) return "0%";
  return `${((n / total) * 100).toFixed(1)}%`;
}

function AppUsage({
  stats, days, heat, setHeat, range, setRange,
}: {
  stats: Stats | null;
  days: DayRow[];
  heat: "daily" | "weekly" | "cumulative";
  setHeat: (id: "daily" | "weekly" | "cumulative") => void;
  range: 7 | 30 | 90;
  setRange: (n: 7 | 30 | 90) => void;
}) {
  const total = stats?.activity.totalTokens ?? 0;
  const providers = Object.entries(stats?.providers ?? {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const providerTotal = providers.reduce((n, [, v]) => n + v, 0);
  const models = modelTotals(days);
  return (
    <>
      <section className="usage-card usage-activity-card">
        <div className="usage-activity">
          <Stat icon="doc" tone="blue" value={compact(total)} label="Total tokens" hint="Tokens from successful model calls" />
          <Stat icon="bars" tone="blue" value={compact(stats?.activity.peakTokens ?? 0)} label="Peak tokens" hint="Largest single model call" />
          <Stat icon="clock" tone="blue" value={duration(stats?.activity.longestSessionMs ?? 0)} label="Longest session" />
          <Stat icon="bolt" tone="blue" value={`${stats?.activity.currentStreakDays ?? 0} d`} label="Current streak" />
          <Stat icon="trophy" tone="purple" value={`${stats?.activity.longestStreakDays ?? 0} d`} label="Longest streak" />
        </div>
      </section>

      <section className="usage-card">
        <div className="usage-card__top">
          <div>
            <b>Token activity</b>
            <p className="usage-muted">Each square represents a day. Brighter colors indicate higher token usage.</p>
          </div>
          <div className="usage-pills">
            {(["daily", "weekly", "cumulative"] as const).map((id) => (
              <button key={id} type="button" className={heat === id ? "is-on" : ""} onClick={() => setHeat(id)}>{id[0].toUpperCase() + id.slice(1)}</button>
            ))}
          </div>
        </div>
        <Heatmap days={days} mode={heat} monthsBelow />
      </section>

      <section className="usage-card">
        <div className="usage-card__top">
          <div>
            <b>Daily token trend by model</b>
            <p className="usage-muted">Tokens processed per day, split by model.</p>
          </div>
          <div className="usage-pills">
            {([7, 30, 90] as const).map((n) => (
              <button key={n} type="button" className={range === n ? "is-on" : ""} onClick={() => setRange(n)}>Last {n} days</button>
            ))}
          </div>
        </div>
        <ModelTrend days={fillDays(days, range, stats?.refreshedAt)} />
      </section>

      <div className="usage-split">
        <section className="usage-card">
          <div className="usage-card__top">
            <b>Model usage <Info text="Share of tokens by model" /></b>
            <span className="usage-muted">Total: {compact(total)} tokens</span>
          </div>
          <div className="usage-donut-row">
            <Donut slices={models.map((m, i) => ({ value: m.tokens, color: MODEL_COLORS[i % MODEL_COLORS.length] }))} center={compact(total)} caption="tokens" />
            <ul className="usage-share">
              {models.map((m, i) => (
                <li key={m.name}>
                  <i style={{ background: MODEL_COLORS[i % MODEL_COLORS.length] }} />
                  <span>{m.name}</span>
                  <b>{compact(m.tokens)}</b>
                  <em>{shareLabel(m.tokens, total)}</em>
                </li>
              ))}
              {models.length === 0 && <li className="usage-muted">No model usage yet.</li>}
            </ul>
          </div>
        </section>

        <section className="usage-card">
          <div className="usage-card__top"><b>Provider distribution <Info text="Share of tokens by provider" /></b></div>
          <div className="usage-donut-col">
            <Donut slices={providers.map(([name, value], i) => ({ value, color: MODEL_COLORS[i % MODEL_COLORS.length] }))} center={compact(providerTotal)} caption="tokens" />
            <ul className="usage-legend usage-legend--block">
              {providers.map(([name, value], i) => (
                <li key={name}><i style={{ background: MODEL_COLORS[i % MODEL_COLORS.length] }} /> {providerLabel(name)} <em>{shareLabel(value, providerTotal)}</em></li>
              ))}
              {providers.length === 0 && <li className="usage-muted">No provider usage yet.</li>}
            </ul>
          </div>
        </section>

        <section className="usage-card">
          <div className="usage-card__top"><b>Task type usage <Info text="Share of tokens by the lane that ran the call" /></b></div>
          <ul className="usage-tasks">
            {TASKS.map((task) => {
              const n = stats?.tasks?.[task.name] ?? 0;
              const ratio = total > 0 ? n / total : 0;
              return (
                <li key={task.name}>
                  <Glyph name={task.icon} />
                  <span>{task.name}</span>
                  <div className="usage-taskbar"><i style={{ width: `${Math.round(ratio * 100)}%`, background: task.color }} /></div>
                  <em>{shareLabel(n, total)}</em>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </>
  );
}

function modelTotals(days: DayRow[]): { name: string; tokens: number }[] {
  const totals = new Map<string, number>();
  for (const day of days) {
    for (const [name, part] of Object.entries(day.models)) totals.set(name, (totals.get(name) ?? 0) + part.tokens);
  }
  return [...totals.entries()].map(([name, tokens]) => ({ name, tokens })).filter((m) => m.tokens > 0).sort((a, b) => b.tokens - a.tokens).slice(0, 6);
}

function Donut({ slices, center, caption }: { slices: { value: number; color: string }[]; center: string; caption: string }) {
  const total = slices.reduce((n, s) => n + s.value, 0);
  const r = 42;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg className="usage-donut" viewBox="0 0 120 120" role="img" aria-label={`${center} ${caption}`}>
      <circle cx="60" cy="60" r={r} fill="none" stroke="#1c2638" strokeWidth="14" />
      {total > 0 && slices.map((s, i) => {
        const len = (s.value / total) * c;
        const node = (
          <circle key={i} cx="60" cy="60" r={r} fill="none" stroke={s.color} strokeWidth="14" strokeLinecap="butt"
            strokeDasharray={`${Math.max(0, len - 1)} ${c}`} strokeDashoffset={-offset} transform="rotate(-90 60 60)" />
        );
        offset += len;
        return node;
      })}
      <text x="60" y="58" textAnchor="middle" className="usage-donut__value">{center}</text>
      <text x="60" y="74" textAnchor="middle" className="usage-donut__caption">{caption}</text>
    </svg>
  );
}

function ModelTrend({ days }: { days: DayRow[] }) {
  const ranked = modelTotals(days).slice(0, 5);
  const max = Math.max(0, ...days.flatMap((d) => ranked.map((m) => d.models[m.name]?.tokens ?? 0)));
  const yMax = max <= 0 ? 0 : niceCeil(max);
  const w = 640;
  const h = 180;
  const pad = { l: 44, r: 8, t: 12, b: 28 };
  const xAt = (i: number) => pad.l + (days.length < 2 ? 0 : (i / (days.length - 1)) * (w - pad.l - pad.r));
  const yAt = (n: number) => pad.t + (yMax <= 0 ? 1 : 1 - n / yMax) * (h - pad.t - pad.b);
  const ticks = yMax <= 0 ? [0] : [yMax, yMax / 2, 0];
  return (
    <div>
      <svg className="usage-lines" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Daily token trend by model">
        {ticks.map((n) => (
          <g key={n}>
            <line x1={pad.l} x2={w - pad.r} y1={yAt(n)} y2={yAt(n)} stroke="#1c2638" />
            <text x={pad.l - 8} y={yAt(n) + 3} textAnchor="end" className="usage-lines__label">{compact(n)}</text>
          </g>
        ))}
        {ranked.map((model, series) => {
          const pts = days.map((d, i) => `${xAt(i)},${yAt(d.models[model.name]?.tokens ?? 0)}`).join(" ");
          return <polyline key={model.name} fill="none" stroke={MODEL_COLORS[series % MODEL_COLORS.length]} strokeWidth="2.5" points={pts} />;
        })}
        {days.map((d, i) => (labelEvery(days.length, i) ? (
          <text key={d.day} x={xAt(i)} y={h - 8} textAnchor="middle" className="usage-lines__label">{shortDay(d.day)}</text>
        ) : null))}
      </svg>
      <div className="usage-legend usage-legend--center">
        {ranked.map((model, i) => (
          <span key={model.name}><i style={{ background: MODEL_COLORS[i % MODEL_COLORS.length], borderRadius: 99 }} /> {model.name}</span>
        ))}
        {ranked.length === 0 && <span>No tokens in this range.</span>}
      </div>
    </div>
  );
}

function niceCeil(n: number): number {
  if (n <= 1) return 1;
  const pow = 10 ** Math.floor(Math.log10(n));
  return Math.ceil(n / pow) * pow;
}

function Info({ text }: { text: string }) {
  return <span className="usage-info" title={text}>i</span>;
}

function Meter(props: { icon: string; tone: string; title: string; value: string; when: string; bar: number; color: string; foot: string; dot?: string }) {
  return (
    <article className="usage-meter">
      <div className="usage-meter__top">
        <span className="usage-meter__name"><Glyph name={props.icon} tone={props.tone} /> {props.title}</span>
        <span className="usage-muted">Reset</span>
      </div>
      <div className="usage-meter__value">
        {props.dot && <i style={{ background: props.dot }} />}
        {props.value}
        <small>{props.when}</small>
      </div>
      <div className="usage-bar"><div style={{ width: `${Math.round(props.bar * 100)}%`, background: props.color }} /></div>
      <div className="usage-meter__foot">{props.foot}</div>
    </article>
  );
}

function Stat({ icon, tone, value, label, hint }: { icon: string; tone: string; value: string; label: string; hint?: string }) {
  return (
    <div className="usage-stat">
      <Glyph name={icon} tone={tone} />
      <div>
        <b>{value}</b>
        <span>{label}{hint && <Info text={hint} />}</span>
      </div>
    </div>
  );
}

function Heatmap({ days, mode, monthsBelow = false }: { days: DayRow[]; mode: "daily" | "weekly" | "cumulative"; monthsBelow?: boolean }) {
  const map = new Map(days.map((d) => [d.day, d.tokens]));
  const today = new Date();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - 52 * 7 - ((start.getUTCDay() + 6) % 7));
  const cells: { day: string; value: number }[] = [];
  let running = 0;
  for (let i = 0; i < 53 * 7; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    const tokens = map.get(key) ?? 0;
    running += tokens;
    const week = Math.floor(i / 7);
    const weekTokens = cells.slice(week * 7, i).reduce((n, c) => n + (map.get(c.day) ?? 0), 0) + tokens;
    cells.push({ day: key, value: mode === "cumulative" ? running : mode === "weekly" ? weekTokens : tokens });
  }
  const max = Math.max(1, ...cells.map((c) => c.value));
  const months = Array.from({ length: 53 }, (_, week) => {
    for (let i = 0; i < 7; i++) {
      const key = cells[week * 7 + i]?.day;
      if (!key) continue;
      const date = new Date(`${key}T00:00:00Z`);
      if (date.getUTCDate() === 1) return date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
    }
    return "";
  });
  const monthRow = (
    <div className={`usage-heat__months${monthsBelow ? " is-below" : ""}`}>
      {months.map((m, i) => <span key={i}>{m}</span>)}
    </div>
  );
  return (
    <div className="usage-heat">
      {!monthsBelow && monthRow}
      <div className="usage-heat__body">
        <div className="usage-heat__days">{"Mon Tue Wed Thu Fri Sat Sun".split(" ").map((d) => <span key={d}>{d}</span>)}</div>
        <div className="usage-heat__grid">
          {cells.map((c) => {
            const level = c.value <= 0 ? 0 : Math.min(4, Math.ceil((c.value / max) * 4));
            return <i key={c.day} data-level={level} title={`${c.day}: ${compact(c.value)} tokens`} />;
          })}
        </div>
        <div className="usage-heat__scale">
          <span>More activity</span>
          <i data-level={4} /><i data-level={3} /><i data-level={2} /><i data-level={1} /><i data-level={0} />
          <span>Less activity</span>
        </div>
      </div>
      {monthsBelow && monthRow}
    </div>
  );
}

function Trend({ icon, label, value, delta, series, color }: { icon: string; label: string; value: string; delta: number | null; series: number[]; color: string }) {
  const max = Math.max(1, ...series);
  const pts = series.map((n, i) => {
    const x = (i / Math.max(1, series.length - 1)) * 120;
    const y = 28 - (n / max) * 22;
    return [x, y] as const;
  });
  const line = pts.map(([x, y]) => `${x},${y}`).join(" ");
  const area = pts.length > 1 ? `0,32 ${line} 120,32` : "";
  const up = delta !== null && delta >= 0;
  return (
    <article className="usage-trend">
      <div>
        <div className="usage-trend__label"><Glyph name={icon} /> {label}</div>
        <div className="usage-trend__value">
          <b>{value}</b>
          {delta !== null && <span style={{ color: up ? "#34d399" : "#f87171" }}>{up ? "+" : ""}{Math.round(delta * 100)}%</span>}
        </div>
      </div>
      {series.some((n) => n > 0) && (
        <svg width="120" height="32" viewBox="0 0 120 32" aria-hidden="true">
          {area && <polygon points={area} fill={color} opacity="0.18" />}
          <polyline fill="none" stroke={color} strokeWidth="2" points={line} />
        </svg>
      )}
    </article>
  );
}

function rankedParts(days: DayRow[], metric: "credits" | "usage" | "models" | "tools"): [string, number][] {
  const field = metric === "usage" ? "tokens" : "credits";
  const source = metric === "tools" ? "tools" : "models";
  const totals = new Map<string, number>();
  for (const day of days) {
    for (const [name, part] of Object.entries(day[source])) totals.set(name, (totals.get(name) ?? 0) + part[field]);
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
}

function dayParts(day: DayRow, metric: "credits" | "usage" | "models" | "tools", names: string[]): number[] {
  const field = metric === "usage" ? "tokens" : "credits";
  const source = metric === "tools" ? day.tools : day.models;
  if (metric === "credits" || metric === "usage") {
    const named = names.reduce((n, name) => n + (source[name]?.[field] ?? 0), 0);
    const total = field === "tokens" ? day.tokens : day.credits;
    const rest = Math.max(0, total - named);
    return names.map((name) => source[name]?.[field] ?? 0).concat(rest > 0 ? [rest] : []);
  }
  return names.map((name) => source[name]?.[field] ?? 0);
}

function BarChart({ days, metric, totalLabel }: { days: DayRow[]; metric: "credits" | "usage" | "models" | "tools"; totalLabel: string }) {
  const ranked = rankedParts(days, metric);
  const names = ranked.map(([name]) => name);
  const unit = metric === "usage" ? "tokens" : "credits";
  const stacks = days.map((d) => dayParts(d, metric, names));
  const hasAny = stacks.some((parts) => parts.some((n) => n > 0));
  const max = Math.max(1, ...stacks.map((parts) => parts.reduce((n, v) => n + v, 0)));
  const ticks = hasAny ? [max, (max * 2) / 3, max / 3, 0] : [0];
  return (
    <div>
      <div className="usage-muted">Total: {totalLabel}</div>
      <div className="usage-legend">
        {ranked.map(([name, n], i) => (
          <span key={name}><i style={{ background: SERIES[i % SERIES.length] }} /> {name} {compact(n)} {unit}</span>
        ))}
        {!hasAny && <span>No charges in this range</span>}
      </div>
      <div className="usage-plot">
        <div className="usage-plot__axis" style={hasAny ? undefined : { justifyContent: "flex-end" }}>
          {ticks.map((n, i) => <span key={i}>{compact(n)}</span>)}
        </div>
        <div className="usage-bars">
          {days.map((d, i) => (
            <div key={d.day} className="usage-bars__col" title={`${d.day}: ${compact(stacks[i].reduce((n, v) => n + v, 0))} ${unit}`}>
              <div className="usage-bars__stack">
                {stacks[i].map((n, s) => (
                  <div key={s} style={{ height: `${(n / max) * 100}%`, background: SERIES[s % SERIES.length] }} />
                ))}
              </div>
              <span>{labelEvery(days.length, i) ? shortDay(d.day) : ""}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function labelEvery(count: number, index: number): boolean {
  if (count <= 10) return true;
  const step = count > 40 ? 10 : 5;
  return index % step === 0 || index === count - 1;
}

function shortDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function Health({ days }: { days: DayRow[] }) {
  return (
    <div>
      <div className="usage-legend">
        <span><i style={{ background: "#60a5fa" }} /> ORVYN Pro peak average decode speed</span>
        <span><i style={{ background: "#c4b5fd" }} /> ORVYN Lite peak average decode speed</span>
      </div>
      <div className="usage-health-frame">
        <svg className="usage-health" viewBox="0 0 560 110" role="img" aria-label="System health">
          {[28, 62, 96].map((y) => <line key={y} x1="36" x2="548" y1={y} y2={y} stroke="#1c2638" />)}
        </svg>
        <p className="usage-health-empty">No decode-speed samples in the last 7 days.</p>
      </div>
      <div className="usage-health__dates">
        {days.map((d) => <span key={d.day}>{shortDay(d.day)}</span>)}
      </div>
    </div>
  );
}

function Refresh() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.2-5.8" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

function Glyph({ name, tone }: { name: string; tone?: string }) {
  const path = name === "bolt" ? "M13 2 4 14h7l-1 8 9-12h-7z"
    : name === "cal" ? "M4 5h16v15H4zM4 9h16M8 3v4M16 3v4"
    : name === "box" ? "M12 3 4 7v10l8 4 8-4V7z"
    : name === "doc" ? "M7 3h7l5 5v13H7z"
    : name === "bars" ? "M5 19V10M12 19V5M19 19v-7"
    : name === "clock" ? "M12 7v6l4 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z"
    : name === "flame" ? "M12 3s6 5 6 10a6 6 0 1 1-12 0c0-3 2-5 3-7 0 2 1 3 3 3 0-3 0-6 0-6z"
    : name === "db" ? "M12 3c5 0 8 1.6 8 3.5S17 10 12 10 4 8.4 4 6.5 7 3 12 3zM4 6.5V12c0 1.9 3 3.5 8 3.5s8-1.6 8-3.5V6.5M4 12v5.5C4 19.4 7 21 12 21s8-1.6 8-3.5V12"
    : name === "coin" ? "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v10M9.5 9.5c.6-.8 1.5-1.2 2.5-1.2 1.6 0 2.5.9 2.5 2s-.8 1.8-2.5 2-2.5.8-2.5 2 1 2 2.5 2c1 0 1.9-.4 2.5-1.2"
    : name === "chat" ? "M5 6h14v9H8l-3 3z"
    : name === "code" ? "M9 8 5 12l4 4M15 8l4 4-4 4"
    : name === "search" ? "M11 6a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM20 20l-3.5-3.5"
    : name === "pen" ? "M4 20l4.5-1L19 8.5 15.5 5 5 15.5z"
    : name === "dots" ? "M6 12h.01M12 12h.01M18 12h.01"
    : "M8 21h8M12 17a5 5 0 0 0 5-5c0-4-5-9-5-9s-5 5-5 9a5 5 0 0 0 5 5z";
  return (
    <span className={tone ? `usage-glyph usage-glyph--${tone}` : "usage-glyph"}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        <path d={path} />
      </svg>
    </span>
  );
}
