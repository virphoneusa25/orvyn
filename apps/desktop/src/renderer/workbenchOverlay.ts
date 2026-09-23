export const WORKBENCH_Z = {
  content: 10,
  tabbar: 20,
  popover: 1000,
  modal: 2000,
  tooltip: 3000,
} as const;

export function placePopover(
  anchor: { top: number; bottom: number; left: number; right: number },
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
