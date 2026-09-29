import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ApiError } from "../../lib/api";
import { errorText } from "../query";
import { fmtCompact, fmtDay, initials, logoBg, STATUS_LABEL } from "../format";
import { A, type AIconName } from "./AIcons";

export function Card({ title, sub, action, children, className, id }: { title?: ReactNode; sub?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section className={`a-card${className ? ` ${className}` : ""}`} id={id} aria-label={typeof title === "string" ? title : undefined}>
      {title || action ? <div className="a-card__head">{title ? <h3>{title}</h3> : null}{sub ? <span className="muted">{sub}</span> : null}{action}</div> : null}
      {children}
    </section>
  );
}

export function Skeleton({ h = 16, w = "100%", r = 8, style }: { h?: number; w?: number | string; r?: number; style?: React.CSSProperties }) {
  return <span className="a-skel" style={{ display: "block", height: h, width: w, borderRadius: r, ...style }} aria-hidden="true" />;
}
export function SkeletonRows({ rows = 5, h = 34 }: { rows?: number; h?: number }) {
  return <div style={{ display: "grid", gap: 8 }} aria-busy="true" aria-label="Loading">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} h={h} />)}</div>;
}

export function Empty({ icon = "folder", title, children }: { icon?: AIconName; title: string; children?: ReactNode }) {
  const Ic = A[icon];
  return <div className="a-empty" role="status"><Ic size={30} /><b>{title}</b>{children}</div>;
}

export function ErrorBox({ error, retry }: { error: ApiError | null; retry?: () => void }) {
  if (!error) return null;
  return (
    <div className="a-error" role="alert">
      <A.alert size={18} />
      <span>{error.status === 403 ? "You don't have permission to see this." : errorText(error)}</span>
      {retry && error.status !== 403 ? <button className="btn btn--sm" onClick={retry}><A.refresh size={14} /> Retry</button> : null}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`a-badge a-badge--${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function Bar({ value, max, tone }: { value: number; max: number; tone?: "violet" | "warn" | "bad" | "auto" }) {
  const p = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const t = tone === "auto" ? (p >= 100 ? "bad" : p >= 80 ? "warn" : "") : tone ?? "";
  return <div className={`a-bar${t ? ` a-bar--${t}` : ""}`} role="progressbar" aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${p}%` }} /></div>;
}

export function OrgLogo({ name, seed, size }: { name: string; seed: string; size?: number }) {
  return <span className="a-org__logo" style={{ background: logoBg(seed), ...(size ? { width: size, height: size, borderRadius: size / 4 } : {}) }} aria-hidden="true">{initials(name)}</span>;
}

export function Delta({ value, suffix = "%" }: { value: number | null | undefined; suffix?: string }) {
  if (value === null || value === undefined) return <span className="a-delta a-delta--flat" title="No earlier period to compare">new</span>;
  const cls = value > 0 ? "up" : value < 0 ? "down" : "flat";
  return <span className={`a-delta a-delta--${cls}`}>{value > 0 ? "↑" : value < 0 ? "↓" : ""} {value > 0 ? "+" : ""}{value}{suffix}</span>;
}

export function Sparkline({ values, color = "#a78bfa" }: { values: number[]; color?: string }) {
  const id = useId().replace(/:/g, "");
  if (values.length < 3) return null;
  const W = 96, H = 44;
  const max = Math.max(...values, 1), min = Math.min(...values, 0);
  const pts = values.map((v, i) => [(i / Math.max(1, values.length - 1)) * W, H - 4 - ((v - min) / Math.max(1, max - min)) * (H - 8)] as const);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg className="a-spark" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <defs><linearGradient id={`sp${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity="0.35" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      <path d={`${d} L${W},${H} L0,${H} Z`} fill={`url(#sp${id})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 4, 5, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** Vertical bars with a y-axis, gradient violet → cyan (the mockup's trend charts). */
export function BarChart({ points, height = 150, label, format = fmtCompact, ticks = 5 }: { points: { day: string; value: number }[]; height?: number; label: string; format?: (n: number) => string; ticks?: number }) {
  const id = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);
  // Draw at the container's real width so labels stay readable at every size.
  const box = useRef<HTMLDivElement | null>(null);
  const [W, setW] = useState(520);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => { const w = Math.round(e!.contentRect.width); if (w > 120) setW(w); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = height, L = 40, B = 20, T = 8;
  const max = niceMax(Math.max(...points.map((p) => p.value), 0));
  const step = (W - L - 4) / Math.max(1, points.length);
  const bw = Math.max(3, step * 0.62);
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const every = Math.ceil(points.length / Math.max(2, Math.floor(W / 90)));
  return (
    <div style={{ position: "relative" }} ref={box}>
      <svg className="a-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
        <defs><linearGradient id={`bc${id}`} x1="0" y1="1" x2="0" y2="0"><stop offset="0" stopColor="#7c3aed" /><stop offset="0.6" stopColor="#6366f1" /><stop offset="1" stopColor="#22d3ee" /></linearGradient></defs>
        {Array.from({ length: ticks }, (_, i) => (max / (ticks - 1)) * i).map((t) => (
          <g key={t}><line x1={L} x2={W} y1={y(t)} y2={y(t)} stroke="rgba(140,150,255,.1)" /><text x={L - 6} y={y(t) + 4} fill="#8e97c6" fontSize="11" textAnchor="end">{format(t)}</text></g>
        ))}
        {points.map((p, i) => {
          const x = L + step * i + (step - bw) / 2;
          return (
            <g key={p.day} onMouseEnter={() => setHover(i)}>
              <rect x={L + step * i} y={T} width={step} height={H - T - B} fill="transparent" />
              {p.value > 0 ? <rect x={x} y={y(p.value)} width={bw} height={Math.max(1, y(0) - y(p.value))} rx="2" fill={`url(#bc${id})`} opacity={hover === null || hover === i ? 1 : 0.55} /> : null}
              {i % every === 0 ? <text x={x + bw / 2} y={H - 4} fill="#8e97c6" fontSize="11" textAnchor="middle">{fmtDay(p.day)}</text> : null}
            </g>
          );
        })}
      </svg>
      {hover !== null && points[hover] ? <div className="a-chart-tip" style={{ position: "absolute", top: 0, right: 0, fontSize: 12, padding: "3px 8px", borderRadius: 7, background: "#151c4a", border: "1px solid var(--line-strong)" }}>{fmtDay(points[hover]!.day)} · {points[hover]!.value.toLocaleString("en-US")}</div> : null}
    </div>
  );
}

export const DONUT_COLORS = ["#8b5cf6", "#22d3ee", "#3b82f6", "#d946ef", "#f59e0b", "#94a3b8", "#10b981"];

export function Donut({ parts, center, sub }: { parts: { label: string; value: number }[]; center: string; sub?: string }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  const R = 52, C = 2 * Math.PI * R;
  let off = 0;
  return (
    <svg viewBox="0 0 140 140" width="140" height="140" role="img" aria-label={`${center} ${sub ?? ""}`}>
      <circle cx="70" cy="70" r={R} fill="none" stroke="rgba(140,150,255,.12)" strokeWidth="16" />
      {total > 0 ? parts.map((p, i) => {
        const len = (p.value / total) * C;
        const el = <circle key={p.label} cx="70" cy="70" r={R} fill="none" stroke={DONUT_COLORS[i % DONUT_COLORS.length]} strokeWidth="16" strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-off} transform="rotate(-90 70 70)" />;
        off += len;
        return el;
      }) : null}
      <text x="70" y="70" textAnchor="middle" fill="#fff" fontSize="19" fontWeight="700">{center}</text>
      {sub ? <text x="70" y="88" textAnchor="middle" fill="#8e97c6" fontSize="11">{sub}</text> : null}
    </svg>
  );
}

export function CopyId({ value, label }: { value: string | null | undefined; label?: string }) {
  const [done, setDone] = useState(false);
  if (!value) return <span className="muted">—</span>;
  return (
    <button className="a-copy a-mono" title={`Copy ${label ?? value}`} aria-label={`Copy ${label ?? "id"}`} onClick={(e) => { e.stopPropagation(); void navigator.clipboard?.writeText(value).then(() => { setDone(true); window.setTimeout(() => setDone(false), 1200); }); }}>
      <span>{value}</span>{done ? <A.check size={14} /> : <A.copy size={14} />}
    </button>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize);
  const list: (number | "…")[] = [];
  for (let p = 1; p <= pages; p++) {
    if (p === 1 || p === pages || Math.abs(p - page) <= 2) list.push(p);
    else if (list[list.length - 1] !== "…") list.push("…");
  }
  return (
    <nav className="a-pager" aria-label="Pagination">
      <span>Showing {from.toLocaleString("en-US")}–{to.toLocaleString("en-US")} of {total.toLocaleString("en-US")}</span>
      <span className="a-pager__pages">
        <button disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><A.chevLeft size={14} /></button>
        {list.map((p, i) => p === "…" ? <span key={`e${i}`} style={{ padding: "0 4px" }}>…</span> : <button key={p} className={p === page ? "is-on" : ""} aria-current={p === page ? "page" : undefined} onClick={() => onPage(p)}>{p}</button>)}
        <button disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page"><A.chevRight size={14} /></button>
      </span>
    </nav>
  );
}

export function Toggle({ on, label }: { on: boolean; label: string }) {
  return <span className={`a-toggle${on ? " is-on" : ""}`} role="img" aria-label={`${label}: ${on ? "on" : "off"}`} />;
}
