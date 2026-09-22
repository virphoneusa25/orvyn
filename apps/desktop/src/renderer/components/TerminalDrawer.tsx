import React, { useEffect, useRef } from "react";
import { clampTerminalHeight, TERMINAL_MIN_HEIGHT } from "../desktopLayout";
import { TerminalView, useTerminalSession } from "./BottomWorkPanel";

export function TerminalDrawer({
  open,
  height,
  onHeightChange,
  onClose,
}: {
  open: boolean;
  height: number;
  onHeightChange: (h: number) => void;
  onClose: () => void;
}) {
  const term = useTerminalSession();
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (open && !term.sessionId && !term.busy && !started.current) {
      started.current = true;
      void term.start();
    }
    if (!open) started.current = false;
  }, [open, term.sessionId, term.busy]);

  useEffect(() => {
    if (!open) return;
    const focus = () => {
      const input = document.querySelector<HTMLInputElement>(".orvyn-terminal-drawer input");
      input?.focus();
    };
    const t = window.setTimeout(focus, 80);
    return () => window.clearTimeout(t);
  }, [open]);

  const h = open ? clampTerminalHeight(height, window.innerHeight) : 0;

  return (
    <div
      className="orvyn-terminal-drawer"
      style={{
        height: h,
        opacity: open ? 1 : 0,
        overflow: "hidden",
        flexShrink: 0,
        background: "var(--orvyn-surface-1)",
        borderTop: open ? "1px solid var(--orvyn-border-soft)" : "1px solid transparent",
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        transition: dragRef.current ? "none" : "height 180ms ease, opacity 160ms ease",
        pointerEvents: open ? "auto" : "none",
      }}
    >
      <div
        onPointerDown={(e) => {
          dragRef.current = { startY: e.clientY, startH: height };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!dragRef.current) return;
          const next = clampTerminalHeight(dragRef.current.startH + (dragRef.current.startY - e.clientY), window.innerHeight);
          onHeightChange(next);
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
        title="Drag to resize terminal"
        style={{ height: 5, cursor: "ns-resize", flexShrink: 0 }}
      />
      <div style={{ display: "flex", alignItems: "center", height: 26, padding: "0 8px", flexShrink: 0 }}>
        <span style={{ fontSize: 10.5, fontWeight: 650, letterSpacing: 0.6, color: "var(--orvyn-text-muted)" }}>TERMINAL</span>
        <span style={{ marginLeft: 8, fontSize: 10, color: "var(--orvyn-text-muted)" }}>
          Local shell · same PTY as the right-panel Terminal tab
        </span>
        <button
          type="button"
          onClick={() => {
            void term.kill();
            onClose();
          }}
          title="Close terminal"
          style={{
            marginLeft: "auto",
            background: "transparent",
            border: "none",
            color: "var(--orvyn-text-muted)",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          Close
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <TerminalView term={term} />
      </div>
      <div style={{ height: 0, overflow: "hidden" }} aria-hidden>
        {TERMINAL_MIN_HEIGHT}
      </div>
    </div>
  );
}
