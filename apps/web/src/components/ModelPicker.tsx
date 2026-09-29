import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { Icon } from "./Icons";

/** ORVYN's models by name (AUTO, Fast, Reasoning, Code, Research, Vision) and the customer's own. Never a vendor. */
export function ModelPicker({ small, up }: { small?: boolean; up?: boolean }) {
  const { models, model, setModel } = useStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const on = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", on);
    return () => window.removeEventListener("mousedown", on);
  }, []);
  const orvyn = models.filter((m) => m.kind === "orvyn");
  const mine = models.filter((m) => m.kind === "user");
  const current = models.find((m) => m.id === model);
  const label = !current || current.id === "auto" ? "AUTO" : current.name;
  return (
    <div className="mp" ref={ref}>
      <button className={`mp__btn${small ? " mp__btn--sm" : ""}`} onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open} data-testid="model-picker">
        <Icon.layers size={20} /> {label} <Icon.down size={16} />
      </button>
      {open && (
        <div className={`mp__menu${up ? " mp__menu--up" : ""}`} role="listbox">
          <div className="mp__group">ORVYN models</div>
          {(orvyn.length ? orvyn : [{ id: "auto", name: "Auto", description: "Best model for your request", kind: "orvyn" as const }]).map((m) => (
            <button key={m.id} className={`mp__item${m.id === model ? " is-on" : ""}`} role="option" aria-selected={m.id === model} disabled={m.available === false} onClick={() => { setModel(m.id); setOpen(false); }}>
              <span style={{ width: 18 }}>{m.id === model ? <Icon.check size={16} /> : null}</span>
              <span><b>{m.id === "auto" ? "AUTO" : m.name}</b><span>{m.available === false ? "Not available right now" : m.description}</span></span>
            </button>
          ))}
          {mine.length ? <div className="mp__group">Your models</div> : null}
          {mine.map((m) => (
            <button key={m.id} className={`mp__item${m.id === model ? " is-on" : ""}`} role="option" aria-selected={m.id === model} onClick={() => { setModel(m.id); setOpen(false); }}>
              <span style={{ width: 18 }}>{m.id === model ? <Icon.check size={16} /> : null}</span>
              <span><b>{m.name}</b><span>Your model · uses your provider account</span></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
