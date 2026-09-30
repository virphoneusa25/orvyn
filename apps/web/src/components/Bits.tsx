import { useEffect } from "react";
import { pct } from "../lib/format";

export function Bar({ used, limit, warn, hidePct }: { used: number; limit: number; warn?: boolean; hidePct?: boolean }) {
  const p = pct(used, limit);
  return (
    <div className="bar">
      <div className="bar__track"><div className={`bar__fill${warn || p >= 90 ? " bar__fill--warn" : ""}`} style={{ width: `${p}%` }} /></div>
      {hidePct ? null : <span className="bar__pct">{p}%</span>}
    </div>
  );
}

export function Modal({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} role="dialog" aria-modal="true" aria-label={title}>
      <div className={`card modal${wide ? " modal--wide" : ""}`}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

/** A page's title row: title, one line of context, and the page's main actions. */
export function PageHead({ title, sub, children }: { title: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        {sub ? <p className="page-sub">{sub}</p> : null}
      </div>
      {children ? <div className="row" style={{ flexWrap: "wrap" }}>{children}</div> : null}
    </div>
  );
}

export function Empty({ icon, title, children, action, testid }: { icon?: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode; testid?: string }) {
  return (
    <div className="empty" data-testid={testid}>
      {icon ? <div className="empty__icon">{icon}</div> : null}
      <h3>{title}</h3>
      {children ? <div>{children}</div> : null}
      {action}
    </div>
  );
}

export function Skeleton({ h = 16, w = "100%", style }: { h?: number; w?: number | string; style?: React.CSSProperties }) {
  return <div className="skeleton" style={{ height: h, width: w, ...style }} />;
}

/** Initials for an avatar ("Royce McKnight" → "RM"). */
export function initials(name: string | null | undefined, email?: string): string {
  const n = (name ?? "").trim();
  if (n) return n.split(/\s+/).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
  return (email ?? "?").slice(0, 1).toUpperCase();
}

/** A stable color for a name (project icons, workspace avatars). */
export function hueFor(text: string): string {
  const palette = ["linear-gradient(135deg,#7c3aed,#4f46e5)", "linear-gradient(135deg,#0891b2,#2563eb)", "linear-gradient(135deg,#db2777,#9333ea)", "linear-gradient(135deg,#059669,#0d9488)", "linear-gradient(135deg,#ea580c,#db2777)", "linear-gradient(135deg,#4f46e5,#0891b2)"];
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length]!;
}

/** A workspace's display name: a personal workspace that was never named reads as the person's own. */
export function workspaceLabel(org: { name: string; kind: string }, personName?: string | null): string {
  if (org.kind === "personal" && (!org.name || org.name === "Personal")) return personName ? `${personName}'s workspace` : "Personal workspace";
  return org.name;
}
