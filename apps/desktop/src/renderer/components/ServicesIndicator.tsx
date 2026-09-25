// apps/desktop/src/renderer/components/ServicesIndicator.tsx
//
// Dev servers ORION started keep running after the run ends. This shows
// them in the status bar: what is running, where, for how long, its URL,
// and a Stop button. Nothing here is guessed; it is what the backend and
// the Local Worker report.
import React, { useEffect, useRef, useState } from "react";
import { apiUrl, authHeaders, noteProtectedStatus } from "../connection";
import { activeServices, openableUrl, servicesLabel, statusText, uptime, type ServiceView } from "../servicesModel";

export function ServicesIndicator() {
  const [services, setServices] = useState<ServiceView[]>([]);
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const url = apiUrl("/services");
      try {
        const res = await fetch(url, { headers: authHeaders() });
        noteProtectedStatus(res.status, url);
        if (!res.ok) return;
        const body = await res.json();
        if (alive) setServices(Array.isArray(body.services) ? body.services : []);
      } catch { /* backend offline: keep the last list */ }
    };
    void load();
    const timer = setInterval(load, 4000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const label = servicesLabel(services);
  if (!label) return null;
  const active = activeServices(services);

  const stop = async (id: string) => {
    setStopping((s) => new Set(s).add(id));
    try {
      await fetch(apiUrl(`/services/${encodeURIComponent(id)}/stop`), { method: "POST", headers: authHeaders() });
      setServices((list) => list.map((s) => (s.serviceId === id ? { ...s, status: "stopped" } : s)));
    } finally {
      setStopping((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  };

  return (
    <span ref={box} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Services ORION started. They keep running after a run finishes."
        style={{ all: "unset", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}
      >
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: active.some((s) => s.status === "unhealthy") ? "var(--orvyn-amber, #e6b35a)" : "var(--orvyn-green)" }} />
        {label}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Running services"
          style={{
            position: "absolute",
            right: 0,
            bottom: "calc(100% + 8px)",
            width: 360,
            background: "var(--orvyn-surface-2, var(--orvyn-surface-1))",
            border: "1px solid var(--orvyn-border-soft)",
            borderRadius: 10,
            boxShadow: "0 12px 32px rgba(0,0,0,.35)",
            padding: 8,
            zIndex: 50,
            color: "var(--orvyn-text, inherit)",
            fontSize: 12,
          }}
        >
          <div style={{ padding: "4px 6px 8px", color: "var(--orvyn-text-muted)", fontSize: 11 }}>
            Running services keep going after the run ends.
          </div>
          {active.map((s) => {
            const url = openableUrl(s);
            return (
              <div key={s.serviceId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px", borderTop: "1px solid var(--orvyn-border-soft)" }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: s.status === "running" ? "var(--orvyn-green)" : "var(--orvyn-amber, #e6b35a)" }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    <strong>{s.name}</strong>{" "}
                    <span style={{ color: "var(--orvyn-text-muted)" }}>
                      · {s.location === "local" ? "Local" : "ORVYN Cloud"} · {statusText(s)} · {uptime(s.startedAt)}
                    </span>
                  </div>
                  <div style={{ fontFamily: "var(--orvyn-font-mono, monospace)", color: "var(--orvyn-text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {url ? (
                      <a href={url} onClick={(e) => { e.preventDefault(); void window.orvyn?.window?.openExternal?.(url); }} style={{ color: "var(--orvyn-accent, #7aa2ff)" }}>{url}</a>
                    ) : (
                      s.command
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={stopping.has(s.serviceId)}
                  onClick={() => void stop(s.serviceId)}
                  style={{ background: "transparent", color: "inherit", border: "1px solid var(--orvyn-border-soft)", borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontSize: 11 }}
                >
                  {stopping.has(s.serviceId) ? "Stopping…" : "Stop"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </span>
  );
}
