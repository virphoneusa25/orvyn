// apps/desktop/src/renderer/components/ResizablePanel.tsx
//
// Drag-to-resize side panels, with hard clamps so a panel can never be sized
// past the viewport. Fixed-width panels are what cause content to render off
// the right edge of the window: two 220px + 400px panels plus an editor will
// overflow a narrow window, and without clamping the overflow just scrolls
// out of sight instead of being clipped.
//
// Width is persisted to localStorage... deliberately NOT: artifacts here run
// in Electron where localStorage is available, but keeping the width in React
// state avoids any storage dependency. Lift it into your own settings if you
// want it to survive restarts.

import React, { useCallback, useEffect, useRef, useState } from "react";

export function ResizablePanel({
  side,
  defaultWidth,
  minWidth = 180,
  maxWidth = 720,
  children,
}: {
  /** Which edge the drag handle sits on. */
  side: "left" | "right";
  defaultWidth: number;
  minWidth?: number;
  maxWidth?: number;
  children: React.ReactNode;
}) {
  const [width, setWidth] = useState(defaultWidth);
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  const startW = useRef(0);

  // Never let a panel exceed 45% of the window — this is the clamp that stops
  // panels from pushing each other off-screen when the window is resized down.
  const clamp = useCallback(
    (w: number) => {
      const viewportMax = Math.min(maxWidth, window.innerWidth * 0.45);
      return Math.max(minWidth, Math.min(w, viewportMax));
    },
    [minWidth, maxWidth]
  );

  useEffect(() => {
    setWidth((w) => clamp(w));
    const onResize = () => setWidth((w) => clamp(w));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clamp]);

  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      const delta = side === "left" ? e.clientX - startX.current : startX.current - e.clientX;
      setWidth(clamp(startW.current + delta));
    }
    function onUp() {
      setDragging(false);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    // Stop the editor/text selecting while dragging.
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragging, side, clamp]);

  const handle = (
    <div
      onMouseDown={(e) => {
        startX.current = e.clientX;
        startW.current = width;
        setDragging(true);
      }}
      onDoubleClick={() => setWidth(defaultWidth)}
      title="Drag to resize · double-click to reset"
      style={{
        width: 4,
        cursor: "col-resize",
        background: dragging ? "var(--accent)" : "transparent",
        flexShrink: 0,
        transition: dragging ? "none" : "background 120ms ease",
      }}
      onMouseEnter={(e) => {
        if (!dragging) e.currentTarget.style.background = "var(--border-strong)";
      }}
      onMouseLeave={(e) => {
        if (!dragging) e.currentTarget.style.background = "transparent";
      }}
    />
  );

  return (
    <>
      {side === "right" && handle}
      <div
        style={{
          width,
          flexShrink: 0,
          // minWidth:0 lets inner flex children shrink instead of forcing the
          // panel wider than its assigned width.
          minWidth: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-panel)",
          [side === "left" ? "borderRight" : "borderLeft"]: "1px solid var(--border)",
        } as React.CSSProperties}
      >
        {children}
      </div>
      {side === "left" && handle}
    </>
  );
}
