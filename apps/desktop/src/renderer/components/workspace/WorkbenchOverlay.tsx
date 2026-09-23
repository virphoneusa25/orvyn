import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export const WORKBENCH_Z = {
  content: 10,
  tabbar: 20,
  popover: 1000,
  modal: 2000,
  tooltip: 3000,
} as const;

export function placePopover(
  anchor: DOMRect,
  width: number,
  height: number,
  align: "left" | "right" = "left",
  viewport?: { width: number; height: number }
) {
  const pad = 8;
  const vw = viewport?.width ?? (typeof window !== "undefined" ? window.innerWidth : 1280);
  const vh = viewport?.height ?? (typeof window !== "undefined" ? window.innerHeight : 800);
  let top = anchor.bottom + 6;
  let left = align === "right" ? anchor.right - width : anchor.left;
  if (top + height > vh - pad) top = Math.max(pad, anchor.top - 6 - height);
  if (left + width > vw - pad) left = Math.max(pad, vw - width - pad);
  if (left < pad) left = pad;
  if (top < pad) top = pad;
  return { top, left };
}

export function WorkbenchPopover({
  open,
  anchor,
  onClose,
  children,
  align = "left",
  width = 280,
  testId,
}: {
  open: boolean;
  anchor: HTMLElement | null;
  onClose: () => void;
  children: React.ReactNode;
  align?: "left" | "right";
  width?: number;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const box = ref.current?.getBoundingClientRect();
    const height = box?.height ?? 320;
    setPos(placePopover(anchor.getBoundingClientRect(), width, height, align));
  }, [open, anchor, width, align]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, anchor, onClose]);

  if (!open || !anchor || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={ref}
      data-testid={testId}
      data-workbench-portal="true"
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width,
        zIndex: WORKBENCH_Z.popover,
        background: "var(--orvyn-surface-2)",
        border: "1px solid var(--orvyn-border)",
        borderRadius: 12,
        boxShadow: "0 18px 48px rgba(3, 8, 20, 0.55)",
        overflow: "hidden",
      }}
    >
      {children}
    </div>,
    document.body
  );
}
