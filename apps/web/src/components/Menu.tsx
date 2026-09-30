import { useEffect, useRef, useState } from "react";

/** Closes a popover on an outside click or Escape. */
export function useDismiss<T extends HTMLElement>(open: boolean, close: () => void) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [open, close]);
  return ref;
}

export interface MenuItem { label: string; icon?: React.ReactNode; onClick: () => void; danger?: boolean; testid?: string; hidden?: boolean }

/** A kebab (or any trigger) with a small action menu. */
export function ActionMenu({ items, label, trigger, align = "right", up }: { items: (MenuItem | "sep")[]; label: string; trigger: React.ReactNode; align?: "left" | "right"; up?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="kebab" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}>{trigger}</button>
      {open ? (
        <div className={`menu menu--${align} ${up ? "menu--up" : "menu--down"}`} role="menu">
          {items.filter((i) => i === "sep" || !i.hidden).map((i, n) => i === "sep" ? <div key={`s${n}`} className="menu__sep" /> : (
            <button key={i.label} role="menuitem" className={`menu__item${i.danger ? " menu__item--danger" : ""}`} data-testid={i.testid} onClick={(e) => { e.stopPropagation(); setOpen(false); i.onClick(); }}>{i.icon}{i.label}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
