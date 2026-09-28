// apps/desktop/src/renderer/onboarding/OnboardingOrb.tsx
//
// The ORVYN orb at onboarding scale, drawn from the brand animation: a glossy
// pink-violet sphere inside a bright white rim, flowing blue light ribbons,
// and a deep blue halo. Pure SVG + CSS (no canvas, no WebGL) so it stays
// light on the GPU. Motion depends on `state`, and a reduced-motion
// preference keeps it still.

import React, { useEffect, useId, useRef, useState } from "react";
import "./onboardingOrb.css";
import orbVideo from "./orion-orb.webm";

/** How fast the brand animation plays in each state. */
const RATE: Record<string, number> = { dormant: 0.45, awakening: 0.8, idle: 1, speaking: 1.2, listening: 0.9, thinking: 1.5, connecting: 1.3, success: 1, warning: 0.8 };

function reducedMotion(): boolean {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

export type OrbState =
  | "dormant"
  | "awakening"
  | "idle"
  | "speaking"
  | "listening"
  | "thinking"
  | "connecting"
  | "success"
  | "warning";

export function OnboardingOrb({ state = "idle", size = 220, label }: { state?: OrbState; size?: number; label?: string }) {
  const id = useId().replace(/:/g, "");
  const g = (name: string) => `${name}-${id}`;
  // The real ORION animation (the brand orb); the drawn SVG below is the
  // fallback when video cannot play. Reduced motion shows its still frame.
  const video = useRef<HTMLVideoElement | null>(null);
  const [videoOk, setVideoOk] = useState(true);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.playbackRate = RATE[state] ?? 1;
    if (reducedMotion()) { v.pause(); return; }
    void v.play().catch(() => undefined);
  }, [state, videoOk]);
  return (
    <div
      className={`ob-orb ob-orb--${state}${videoOk ? " ob-orb--video" : ""}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={label ?? "ORION"}
      data-orb-state={state}
    >
      <div className="ob-orb__halo" aria-hidden="true" />
      {videoOk ? (
        <video
          ref={video}
          className="ob-orb__video"
          src={orbVideo}
          autoPlay={!reducedMotion()}
          muted
          loop
          playsInline
          preload="auto"
          aria-hidden="true"
          onError={() => setVideoOk(false)}
        />
      ) : null}
      <svg className="ob-orb__svg" viewBox="0 0 200 200" aria-hidden="true">
        <defs>
          <radialGradient id={g("core")} cx="42%" cy="38%" r="68%">
            <stop offset="0%" stopColor="#FBD3FF" />
            <stop offset="28%" stopColor="#E879F9" />
            <stop offset="58%" stopColor="#A855F7" />
            <stop offset="82%" stopColor="#6D5BFF" />
            <stop offset="100%" stopColor="#3B4BFF" />
          </radialGradient>
          <linearGradient id={g("wave")} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#7C4DFF" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#3B82F6" stopOpacity="0.55" />
          </linearGradient>
          <radialGradient id={g("gloss")} cx="35%" cy="28%" r="45%">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.75" />
            <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={g("ribbon")} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#31C8FF" stopOpacity="0" />
            <stop offset="45%" stopColor="#B9C6FF" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#7C4DFF" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={g("arc")} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#22D3EE" />
            <stop offset="100%" stopColor="#8B5CF6" />
          </linearGradient>
          <filter id={g("soft")} x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="1.6" />
          </filter>
          <filter id={g("glow")} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3.2" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <clipPath id={g("clip")}><circle cx="100" cy="100" r="46" /></clipPath>
        </defs>

        {/* Light ribbons that sweep around the sphere. */}
        <g className="ob-orb__ribbons" filter={`url(#${g("soft")})`}>
          <ellipse cx="100" cy="100" rx="70" ry="54" fill="none" stroke={`url(#${g("ribbon")})`} strokeWidth="2.2" transform="rotate(-28 100 100)" />
          <ellipse cx="100" cy="100" rx="66" ry="58" fill="none" stroke={`url(#${g("ribbon")})`} strokeWidth="1.2" transform="rotate(34 100 100)" opacity="0.8" />
          <ellipse cx="100" cy="100" rx="74" ry="50" fill="none" stroke={`url(#${g("ribbon")})`} strokeWidth="0.9" transform="rotate(72 100 100)" opacity="0.65" />
          <path d="M40 118 C 60 150, 128 160, 158 122" fill="none" stroke="#9FB2FF" strokeOpacity="0.55" strokeWidth="1.4" />
          <path d="M46 84 C 70 44, 140 40, 162 90" fill="none" stroke="#C4B5FD" strokeOpacity="0.45" strokeWidth="1" />
        </g>

        {/* Connection arcs (connecting). */}
        <g className="ob-orb__arcs">
          <path d="M100 38 A62 62 0 0 1 162 100" fill="none" stroke={`url(#${g("arc")})`} strokeWidth="2.4" strokeLinecap="round" filter={`url(#${g("glow")})`} />
          <path d="M100 162 A62 62 0 0 1 38 100" fill="none" stroke={`url(#${g("arc")})`} strokeWidth="2.4" strokeLinecap="round" filter={`url(#${g("glow")})`} />
        </g>

        {/* Listening ripples. */}
        <g className="ob-orb__ripples" fill="none" stroke="#A5B4FC">
          <circle cx="100" cy="100" r="52" />
          <circle cx="100" cy="100" r="52" />
        </g>

        {/* The sphere: gradient core, moving inner waves, gloss. */}
        <g className="ob-orb__sphere">
          <circle cx="100" cy="100" r="46" fill={`url(#${g("core")})`} />
          <g clipPath={`url(#${g("clip")})`} className="ob-orb__waves">
            <path d="M40 112 C 70 82, 92 132, 124 102 S 160 92, 170 110 L 170 170 L 40 170 Z" fill={`url(#${g("wave")})`} opacity="0.55" />
            <path d="M58 70 C 80 92, 96 60, 118 78 S 150 70, 160 84" fill="none" stroke="#F0ABFC" strokeOpacity="0.6" strokeWidth="6" strokeLinecap="round" />
          </g>
          <circle cx="100" cy="100" r="46" fill={`url(#${g("gloss")})`} />
        </g>

        {/* The bright rim. */}
        <circle className="ob-orb__rim" cx="100" cy="100" r="48" fill="none" stroke="#F4F2FF" strokeWidth="2.6" filter={`url(#${g("glow")})`} />
        <circle cx="100" cy="100" r="51" fill="none" stroke="#8EA2FF" strokeOpacity="0.45" strokeWidth="1.2" />
      </svg>
    </div>
  );
}
