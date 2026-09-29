import { pct } from "../lib/format";

export function Bar({ used, limit, warn }: { used: number; limit: number; warn?: boolean }) {
  const p = pct(used, limit);
  return (
    <div className="bar">
      <div className="bar__track"><div className={`bar__fill${warn || p >= 90 ? " bar__fill--warn" : ""}`} style={{ width: `${p}%` }} /></div>
      <span className="bar__pct">{p}%</span>
    </div>
  );
}

export function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="modal-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} role="dialog" aria-label={title}>
      <div className="card modal">
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}
