// apps/desktop/src/renderer/components/redesign/HeroBackdrop.tsx
// Animated background behind the greeting + composer: a rotating faceted
// ORVYN hexagon, a counter-rotating dotted ring, a drifting honeycomb that
// fades out under the text, two breathing indigo glows and twinkling nodes.
// Pure SVG + CSS keyframes (see redesign.css) — no JS animation loop, so it
// costs nothing on the main thread. Respects prefers-reduced-motion.
import React, { useId } from "react";

const FACET_COLORS = ["#C3CAFF", "#98A4FF", "#6272FF", "#4657E8", "#2B389E", "#3746C4"];

function polar(r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [r * Math.cos(a), r * Math.sin(a)];
}

function hexPath(r: number, rotation: number): string {
  const pts = Array.from({ length: 6 }, (_, i) => polar(r, rotation + 60 * i));
  return "M" + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L") + "Z";
}

// Outer hex (pointy-top) and an inner hex twisted 20° → aperture-style facets,
// matching the ORVYN mark.
const OUTER = Array.from({ length: 6 }, (_, i) => polar(200, -90 + 60 * i));
const INNER = Array.from({ length: 6 }, (_, i) => polar(92, -70 + 60 * i));
const FACETS = OUTER.map((o, i) => {
  const o2 = OUTER[(i + 1) % 6];
  const i2 = INNER[(i + 1) % 6];
  const i1 = INNER[i];
  const f = (p: [number, number]) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
  return { d: `M${f(o)}L${f(o2)}L${f(i2)}L${f(i1)}Z`, color: FACET_COLORS[i] };
});

const NODES: [number, number, number][] = [
  [612, 70, 0], [700, 300, 1.2], [1030, 58, 2.1], [1068, 310, 0.6],
  [560, 210, 2.8], [820, 26, 1.7], [960, 352, 3.3], [480, 120, 0.9],
];

export function HeroBackdrop({ animate = true }: { animate?: boolean }) {
  // Unique ids so two heroes on screen never share defs.
  const uid = useId().replace(/:/g, "");
  const id = (s: string) => `${s}-${uid}`;

  return (
    <svg
      className={`ov-hero__backdrop${animate ? " ov-anim" : ""}`}
      viewBox="0 0 1112 400"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <pattern id={id("hex")} width="34.64" height="60" patternUnits="userSpaceOnUse">
          <path
            d="M17.32 0L34.64 10L34.64 30L17.32 40L0 30L0 10ZM17.32 40V60"
            fill="none"
            stroke="#98A4FF"
            strokeOpacity="0.09"
            strokeWidth="1"
          />
        </pattern>
        <linearGradient id={id("fade")} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0.25" stopColor="#000" />
          <stop offset="0.75" stopColor="#fff" />
        </linearGradient>
        <mask id={id("mask")}>
          <rect width="1112" height="400" fill={`url(#${id("fade")})`} />
        </mask>
        <radialGradient id={id("g1")}>
          <stop offset="0" stopColor="#5563F5" stopOpacity="0.45" />
          <stop offset="1" stopColor="#5563F5" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={id("g2")}>
          <stop offset="0" stopColor="#98A4FF" stopOpacity="0.22" />
          <stop offset="1" stopColor="#98A4FF" stopOpacity="0" />
        </radialGradient>
      </defs>

      <circle className="ov-breathe" cx="900" cy="140" r="380" fill={`url(#${id("g1")})`} />
      <circle className="ov-breathe-2" cx="180" cy="420" r="300" fill={`url(#${id("g2")})`} />

      <g mask={`url(#${id("mask")})`}>
        <rect className="ov-drift" x="0" y="0" width="1300" height="560" fill={`url(#${id("hex")})`} />
      </g>

      <g transform="translate(905 190)">
        <g className="ov-spin-rev">
          <path
            d={hexPath(300, -90)}
            fill="none"
            stroke="#98A4FF"
            strokeOpacity="0.18"
            strokeWidth="1"
            strokeDasharray="2 10"
          />
        </g>
        <g className="ov-spin">
          <path d={hexPath(250, -60)} fill="none" stroke="#98A4FF" strokeOpacity="0.14" strokeWidth="1" />
          {FACETS.map((f) => (
            <path
              key={f.d}
              d={f.d}
              fill={f.color}
              fillOpacity="0.16"
              stroke="#C3CAFF"
              strokeOpacity="0.28"
              strokeWidth="1"
            />
          ))}
        </g>
      </g>

      {NODES.map(([cx, cy, delay]) => (
        <circle
          key={`${cx}-${cy}`}
          className="ov-twinkle"
          cx={cx}
          cy={cy}
          r="2"
          fill="#C3CAFF"
          style={{ animationDelay: `-${delay}s` }}
        />
      ))}
    </svg>
  );
}
