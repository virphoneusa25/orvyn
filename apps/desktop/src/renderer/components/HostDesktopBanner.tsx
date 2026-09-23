import React, { useEffect, useState } from "react";
import { apiUrl, authHeaders } from "../connection";

interface HostState {
  allowed: boolean;
  controlling: boolean;
  controlOwner: "orion" | "user" | "none";
  lastAction?: string;
}

export function HostDesktopBanner() {
  const [state, setState] = useState<HostState | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const r = await fetch(apiUrl("/host-desktop"), { headers: authHeaders() });
        if (!r.ok) return;
        const d = await r.json();
        if (alive) setState(d);
      } catch {
        /* backend offline */
      }
    }
    void load();
    const timer = setInterval(load, 2500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (!state?.allowed || state.controlOwner === "none") return null;

  async function post(path: string) {
    const r = await fetch(apiUrl(path), { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: "{}" });
    if (r.ok) setState(await r.json());
  }

  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "7px 12px",
        background: state.controlOwner === "orion" ? "rgba(85,99,245,0.18)" : "rgba(230,179,90,0.16)",
        borderBottom: "1px solid var(--orvyn-border-soft)",
        fontSize: 12,
        color: "var(--orvyn-text)",
        flexShrink: 0,
      }}
    >
      <strong>
        {state.controlOwner === "orion" ? "ORION controlling this computer" : "You have control of this computer"}
      </strong>
      <span style={{ color: "var(--orvyn-text-muted)" }}>Host Windows desktop — not cloud Desktop, not Browser</span>
      <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
        {state.controlOwner === "orion" ? (
          <button type="button" onClick={() => void post("/host-desktop/take-control")} style={btn}>
            Take Control
          </button>
        ) : (
          <button type="button" onClick={() => void post("/host-desktop/return-control")} style={btn}>
            Return to ORION
          </button>
        )}
        <button type="button" onClick={() => void post("/host-desktop/take-control")} style={btn}>
          Stop
        </button>
      </span>
    </div>
  );
}

const btn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--orvyn-border)",
  borderRadius: 6,
  color: "var(--orvyn-text)",
  padding: "3px 10px",
  fontSize: 11,
  cursor: "pointer",
};
