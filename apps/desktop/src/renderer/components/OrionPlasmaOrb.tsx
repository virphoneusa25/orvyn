import React from "react";
import "./orion-plasma-orb.css";

/**
 * 22px plasma orb. Layers are CSS- and SVG-animated (no canvas, no rAF).
 * Ribbons are irregular paths with independent dash, spin, and scale timings
 * so the loop does not read as one rotating circle.
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
      <svg className="opo__svg" viewBox="0 0 64 64" focusable="false">
        <defs>
          <radialGradient id={core} cx="34%" cy="30%" r="72%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="14%" stopColor="#d7fbff" />
            <stop offset="32%" stopColor="#49d4ff" />
            <stop offset="52%" stopColor="#6d5bff" />
            <stop offset="74%" stopColor="#ff4fd8" />
            <stop offset="100%" stopColor="#b14bff" />
          </radialGradient>
          <radialGradient id={blob} cx="68%" cy="64%" r="58%">
            <stop offset="0%" stopColor="#ff5adf" stopOpacity="1" />
            <stop offset="40%" stopColor="#7cf4ff" stopOpacity="0.75" />
            <stop offset="100%" stopColor="#7cf4ff" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={ribbon} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="38%" stopColor="#9aefff" />
            <stop offset="72%" stopColor="#c4b5fd" />
            <stop offset="100%" stopColor="#ffffff" />
          </linearGradient>
          <linearGradient id={ribbon2} x1="100%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#e0f8ff" />
            <stop offset="45%" stopColor="#67e8f9" />
            <stop offset="100%" stopColor="#e879f9" />
          </linearGradient>
          <filter id={glow} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.15" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <clipPath id={clip}>
            <circle cx="32" cy="32" r="15.5" />
          </clipPath>
        </defs>

        <g className="opo__spin opo__spin-b" filter={`url(#${glow})`}>
          <path
            className="opo__path opo__path-b"
            pathLength={100}
            d="M18 12 C40 0 62 14 56 36 C50 58 28 66 12 48 C-2 32 2 20 18 12"
            fill="none"
            stroke={`url(#${ribbon2})`}
            strokeWidth="7"
            strokeLinecap="round"
          />
        </g>

        <g className="opo__core">
          <circle cx="32" cy="32" r="15.2" fill={`url(#${core})`} />
          <g clipPath={`url(#${clip})`}>
            <ellipse className="opo__blob" cx="40" cy="40" rx="16" ry="10" fill={`url(#${blob})`} />
            <ellipse className="opo__blob opo__blob-b" cx="24" cy="26" rx="11" ry="7" fill="#e9fbff" opacity="0.72" />
            <ellipse cx="34" cy="44" rx="10" ry="6" fill="#ff4ad8" opacity="0.55" />
          </g>
          <ellipse className="opo__spec" cx="23" cy="20" rx="6" ry="3.4" fill="#ffffff" />
        </g>

        <g className="opo__spin opo__spin-a" filter={`url(#${glow})`}>
          <path
            className="opo__path opo__path-a"
            pathLength={100}
            d="M8 34 C10 8 48 2 60 24 C70 42 48 66 28 60 C8 54 -2 46 8 34"
            fill="none"
            stroke={`url(#${ribbon})`}
            strokeWidth="7.4"
            strokeLinecap="round"
          />
          <path
            className="opo__path opo__path-c"
            pathLength={100}
            d="M16 16 C30 4 52 12 54 30 C56 48 34 52 22 40 C14 32 10 24 16 16"
            fill="none"
            stroke="#ffffff"
            strokeWidth="3.6"
            strokeLinecap="round"
          />
        </g>
      </svg>
    </span>
  );
}
