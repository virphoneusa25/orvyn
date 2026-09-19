// apps/desktop/src/renderer/components/HeroBackground.tsx
//
// The approved mockup's animated space/network treatment for the Home hero.
// Layered composition on one canvas: deep navy base → nebula radial glow →
// drifting stars → network lines with pulsing nodes. Deliberately slow and
// low-contrast — premium infrastructure, not a game.
//
// Performance/manners: one rAF loop, ~100 primitives, paused when the window
// is hidden; prefers-reduced-motion renders the same composition frozen.

import React, { useEffect, useRef } from "react";

interface Star {
  x: number;
  y: number;
  r: number;
  vx: number;
  tw: number;
}

interface Node {
  x: number;
  y: number;
  r: number;
  pulse: number;
}

export function HeroBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let raf = 0;
    let running = true;
    let t = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, rect.width * dpr);
      canvas.height = Math.max(1, rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return rect;
    };
    let rect = resize();

    // Seeded, stable scatter — recomputed only on resize.
    let stars: Star[] = [];
    let nodes: Node[] = [];
    const seed = () => {
      const w = rect.width || 600;
      const h = rect.height || 300;
      stars = Array.from({ length: 90 }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        r: Math.random() * 1.1 + 0.3,
        vx: (Math.random() * 0.06 + 0.015) * (Math.random() < 0.5 ? -1 : 1),
        tw: Math.random() * Math.PI * 2,
      }));
      nodes = Array.from({ length: 13 }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        r: Math.random() * 1.6 + 1,
        pulse: Math.random() * Math.PI * 2,
      }));
    };
    seed();

    const draw = () => {
      const w = rect.width || 600;
      const h = rect.height || 300;
      ctx.clearRect(0, 0, w, h);

      // L1 — deep navy base.
      ctx.fillStyle = "#070B14";
      ctx.fillRect(0, 0, w, h);

      // L2a — planetary horizon: a large sphere off the left edge, its lit
      // rim curving through the hero. Atmospheric band (purple→cyan) on the
      // terminator, dark body fading to the base — global infrastructure,
      // not sci-fi: barely-there albedo, strong single rim.
      const planetR = h * 1.35;
      const pcx = -planetR * 0.52;
      const pcy = h * 0.92;
      const body = ctx.createRadialGradient(pcx, pcy, planetR * 0.72, pcx, pcy, planetR);
      body.addColorStop(0, "rgba(14,20,33,0.9)");
      body.addColorStop(0.85, "rgba(10,14,24,0.85)");
      body.addColorStop(1, "rgba(7,11,20,0)");
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(pcx, pcy, planetR, 0, Math.PI * 2);
      ctx.fill();
      // Rim: stacked strokes hugging the visible arc — a wide faint cyan
      // atmosphere, a purple band, then one strong lit edge. Parity reviews
      // kept reading the earlier 1.6px/α0.26 arc as invisible; the mockup's
      // horizon reads as a clear glow.
      const rimShift = reduced ? 0.5 : (Math.sin(t * 0.003) + 1) / 2;
      ctx.beginPath();
      ctx.arc(pcx, pcy, planetR + 10, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(34,211,238,${0.10 + (1 - rimShift) * 0.08})`;
      ctx.lineWidth = 9;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(pcx, pcy, planetR + 4, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(108,92,255,${0.18 + rimShift * 0.1})`;
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(pcx, pcy, planetR, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(139,125,255,${0.5 + rimShift * 0.18})`;
      ctx.lineWidth = 2.2;
      ctx.stroke();
      // Faint latitude arcs on the visible cap for a "global grid" read.
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.clip();
      for (let i = 1; i <= 3; i++) {
        ctx.beginPath();
        ctx.ellipse(pcx, pcy, planetR, planetR * (0.25 + i * 0.18), 0, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(77,163,255,${0.05 - i * 0.01})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.restore();

      // L2b — nebula glow, slowly breathing between purple and blue.
      const breathe = reduced ? 0.5 : (Math.sin(t * 0.004) + 1) / 2;
      const g1 = ctx.createRadialGradient(w * 0.5, h * -0.25, 0, w * 0.5, h * -0.25, h * 1.7);
      g1.addColorStop(0, `rgba(108,92,255,${0.16 + breathe * 0.07})`);
      g1.addColorStop(0.55, "rgba(108,92,255,0.04)");
      g1.addColorStop(1, "rgba(108,92,255,0)");
      ctx.fillStyle = g1;
      ctx.fillRect(0, 0, w, h);

      const g2 = ctx.createRadialGradient(w * 0.16, h * 1.2, 0, w * 0.16, h * 1.2, h * 1.3);
      g2.addColorStop(0, `rgba(34,211,238,${0.05 + (1 - breathe) * 0.03})`);
      g2.addColorStop(1, "rgba(34,211,238,0)");
      ctx.fillStyle = g2;
      ctx.fillRect(0, 0, w, h);

      // L3 — stars with a soft twinkle.
      for (const s of stars) {
        const tw = reduced ? 0.6 : 0.45 + Math.sin(t * 0.02 + s.tw) * 0.25;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(214,222,255,${tw})`;
        ctx.fill();
        if (!reduced) {
          s.x += s.vx;
          if (s.x < -2) s.x = w + 2;
          if (s.x > w + 2) s.x = -2;
        }
      }

      // L4/L5 — network: connect near nodes, pulse them; lines fade in and
      // out with their endpoints' pulse so the mesh feels alive, not busy.
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]!;
          const b = nodes[j]!;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.hypot(dx, dy);
          if (dist > w * 0.28) continue;
          const alpha = (reduced ? 0.1 : 0.07 + Math.abs(Math.sin(t * 0.006 + a.pulse)) * 0.07) * (1 - dist / (w * 0.3));
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.strokeStyle = `rgba(77,163,255,${Math.max(0, alpha)})`;
          ctx.lineWidth = 0.6;
          ctx.stroke();
        }
      }
      for (const n of nodes) {
        const p = reduced ? 0.5 : (Math.sin(t * 0.012 + n.pulse) + 1) / 2;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + p * 1.1, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(124,92,255,${0.25 + p * 0.35})`;
        ctx.fill();
        // Faint halo on the brightest phase only.
        if (p > 0.75) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r + 5, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(34,211,238,${(p - 0.75) * 0.18})`;
          ctx.fill();
        }
      }

      // L7 — readability scrim over the center where the composer sits.
      const scrim = ctx.createLinearGradient(0, h * 0.35, 0, h);
      scrim.addColorStop(0, "rgba(7,11,20,0)");
      scrim.addColorStop(1, "rgba(7,11,20,0.55)");
      ctx.fillStyle = scrim;
      ctx.fillRect(0, h * 0.35, w, h * 0.65);
    };

    const loop = () => {
      if (!running) return;
      if (!document.hidden) {
        t += 1;
        draw();
      }
      raf = requestAnimationFrame(loop);
    };

    const onResize = () => {
      rect = resize();
      seed();
      draw();
    };
    window.addEventListener("resize", onResize);
    draw();
    if (reduced) {
      // Composition rendered once, no continuous animation.
      running = false;
    } else {
      raf = requestAnimationFrame(loop);
    }

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
      aria-hidden="true"
    />
  );
}
