
export interface DayPoint { label: string; a: number; b: number }

/** Stacked daily bars (model usage / file & image work), in credits. */
export function UsageChart({ points, height = 170 }: { points: DayPoint[]; height?: number }) {
  const W = 560, H = height, L = 38, B = 22, T = 10;
  const max = Math.max(100, ...points.map((p) => p.a + p.b));
  const nice = niceMax(max);
  const bw = Math.min(30, ((W - L - 10) / Math.max(1, points.length)) * 0.55);
  const step = (W - L - 10) / Math.max(1, points.length);
  const y = (v: number) => T + (H - T - B) * (1 - v / nice);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => nice * f);
  return (
    <div>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Credits used per day">
        <defs>
          <linearGradient id="ua" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stopColor="#22d3ee" /><stop offset="1" stopColor="#3b82f6" /></linearGradient>
          <linearGradient id="ub" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stopColor="#a855f7" /><stop offset="1" stopColor="#e879f9" /></linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - 4} y1={y(t)} y2={y(t)} stroke="rgba(140,150,255,.12)" />
            <text x={L - 6} y={y(t) + 4} fill="#8e97c6" fontSize="11" textAnchor="end">{short(t)}</text>
          </g>
        ))}
        {points.map((p, i) => {
          const x = L + step * i + (step - bw) / 2;
          const ya = y(p.a), yb = y(p.a + p.b);
          return (
            <g key={i}>
              {p.a > 0 ? <rect x={x} y={ya} width={bw} height={y(0) - ya} rx="3" fill="url(#ua)" /> : null}
              {p.b > 0 ? <rect x={x} y={yb} width={bw} height={ya - yb} rx="3" fill="url(#ub)" /> : null}
              <text x={x + bw / 2} y={H - 5} fill="#aab2dd" fontSize="11" textAnchor="middle">{p.label}</text>
            </g>
          );
        })}
      </svg>
      <div className="legend"><span><i style={{ background: "#3b82f6" }} />Model usage</span><span><i style={{ background: "#d946ef" }} />Files &amp; images</span></div>
    </div>
  );
}

function niceMax(v: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
function short(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
  return String(Math.round(v));
}
