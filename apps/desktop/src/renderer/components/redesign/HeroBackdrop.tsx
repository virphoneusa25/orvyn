import React from "react";

export function HeroBackdrop({ animate = true }: { animate?: boolean }) {
  return <div className={`ov-hero-backdrop ${animate ? "is-animated" : ""}`} aria-hidden="true">
    <div className="ov-hero-glow" />
    <svg viewBox="0 0 900 320" preserveAspectRatio="xMidYMid slice">
      <defs><pattern id="ovHex" width="44" height="38" patternUnits="userSpaceOnUse"><path d="M11 1h22l10 18-10 18H11L1 19Z" fill="none" stroke="currentColor" strokeWidth=".6"/></pattern></defs>
      <rect width="100%" height="100%" fill="url(#ovHex)" />
      <g className="ov-network-lines"><path d="M530 260 690 155 840 230M690 155 760 55 875 120M530 260 470 120 600 70" fill="none" stroke="currentColor"/><circle cx="690" cy="155" r="3"/><circle cx="760" cy="55" r="3"/><circle cx="530" cy="260" r="3"/></g>
    </svg>
  </div>;
}
