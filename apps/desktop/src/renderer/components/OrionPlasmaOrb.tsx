import React from "react";
import "./orion-plasma-orb.css";

/**
 * 22px plasma orb. Every moving part is an HTML layer animated with
 * transform/opacity only, so the GPU compositor runs it: no per-frame style,
 * layout or repaint on the main thread (the SVG itself is static art, and
 * its glow is a static filter, never re-rasterized). Before, SVG-internal
 * animations (stroke-dashoffset, <g> transforms under a blur filter) forced
 * ~60 restyles + layouts per second for as long as a run was going.
 */
export function OrionPlasmaOrb({ motion = "thinking" }: { motion?: "thinking" | "tool" | "waiting" | "done" | "error" }) {
  const uid = React.useId().replace(/:/g, "");
  const core = `opo-core-${uid}`;
  const blob = `opo-blob-${uid}`;
  const ribbon = `opo-ribbon-${uid}`;
  const ribbon2 = `opo-ribbon2-${uid}`;
  const glow = `opo-glow-${uid}`;
  const clip = `opo-clip-${uid}`;

  return (
    <span className={`opo opo--${motion}`} aria-hidden="true" data-testid="orion-plasma-orb">
      <span className="opo__atmo" />
      <span className="opo__conic opo__conic-a" />
      <span className="opo__conic opo__conic-b" />
      <span className="opo__rot"><svg className="opo__svg" viewBox="0 0 64 64" focusable="false">
        <defs>
          <radialGradient id={core} cx="32%" cy="28%" r="74%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="12%" stopColor="#e7fdff" />
            <stop offset="28%" stopColor="#7af0ff" />
            <stop offset="46%" stopColor="#3b82f6" />
            <stop offset="64%" stopColor="#7c3aed" />
            <stop offset="82%" stopColor="#e879f9" />
            <stop offset="100%" stopColor="#4c1d95" />
          </radialGradient>
          <radialGradient id={blob} cx="62%" cy="70%" r="55%">
            <stop offset="0%" stopColor="#ff4fd8" />
            <stop offset="42%" stopColor="#67e8f9" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#67e8f9" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={ribbon} x1="0%" y1="10%" x2="100%" y2="90%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="36%" stopColor="#a5f3fc" />
            <stop offset="70%" stopColor="#c4b5fd" />
            <stop offset="100%" stopColor="#ffffff" />
          </linearGradient>
          <linearGradient id={ribbon2} x1="100%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#f0fdff" />
            <stop offset="40%" stopColor="#22d3ee" />
            <stop offset="100%" stopColor="#e879f9" />
          </linearGradient>
          <filter id={glow} x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="1.2" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <clipPath id={clip}>
            <circle cx="32" cy="32" r="15.2" />
          </clipPath>
        </defs>

        <g className="opo__spin opo__spin-b">
          <path
            className="opo__path opo__path-b"
            pathLength={100}
            d="M20 8 C44 -2 66 16 58 36 C50 56 30 68 12 52 C-4 38 0 18 20 8"
            fill="none"
            stroke={`url(#${ribbon2})`}
            strokeWidth="8"
            strokeLinecap="round"
          />
        </g>

        <g className="opo__core">
          <circle cx="32" cy="32" r="12.4" fill={`url(#${core})`} />
          <g clipPath={`url(#${clip})`}>
            <ellipse className="opo__blob" cx="42" cy="42" rx="16" ry="9" fill={`url(#${blob})`} />
            <ellipse className="opo__blob opo__blob-b" cx="22" cy="24" rx="12" ry="7" fill="#f4fdff" opacity="0.7" />
            <ellipse cx="36" cy="46" rx="9" ry="5" fill="#ff4ad8" opacity="0.5" />
          </g>
          <ellipse className="opo__spec" cx="22.5" cy="19.5" rx="6.2" ry="3.2" fill="#ffffff" />
          <ellipse className="opo__spec opo__spec-b" cx="26" cy="22" rx="2.4" ry="1.2" fill="#d9fbff" />
        </g>

        <g className="opo__spin opo__spin-a">
          <path
            className="opo__path opo__path-a"
            pathLength={100}
            d="M6 30 C8 6 46 -2 62 22 C74 42 50 68 26 62 C4 56 -4 44 6 30"
            fill="none"
            stroke={`url(#${ribbon})`}
            strokeWidth="9"
            strokeLinecap="round"
          />
          <path
            className="opo__path opo__path-c"
            pathLength={100}
            d="M14 18 C28 4 52 10 56 28 C60 46 36 54 22 42 C12 34 8 26 14 18"
            fill="none"
            stroke="#ffffff"
            strokeWidth="2.6"
            strokeLinecap="round"
            opacity="0.85"
          />
        </g>
      </svg></span>
    </span>
  );
}
