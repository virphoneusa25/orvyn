import React, { useEffect, useMemo, useState } from "react";
import { filterHelpTopics, HELP_TOPICS } from "../helpContent";
import { IconClose, IconSearch } from "./Icons";

export function HelpDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const topics = useMemo(() => filterHelpTopics(HELP_TOPICS, query), [query]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  return (
    <div
      aria-hidden={!open}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 800,
        pointerEvents: open ? "auto" : "none",
      }}
    >
      <div
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(6, 8, 14, 0.45)",
          opacity: open ? 1 : 0,
          transition: "opacity 160ms ease",
        }}
      />
      <aside
        role="dialog"
        aria-label="Help / Getting Started"
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          height: "100%",
          width: "min(420px, 92vw)",
          background: "var(--orvyn-surface-1)",
          borderLeft: "1px solid var(--orvyn-border-soft)",
          boxShadow: "var(--orvyn-shadow)",
          transform: open ? "translateX(0)" : "translateX(100%)",
          opacity: open ? 1 : 0,
          transition: "transform 180ms ease, opacity 160ms ease",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", borderBottom: "1px solid var(--orvyn-border-soft)" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Help / Getting Started</div>
            <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)" }}>Local guide — no account secrets</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close help" title="Close help" style={iconBtn}>
            <IconClose size={14} />
          </button>
        </div>
        <div style={{ padding: 10, borderBottom: "1px solid var(--orvyn-border-soft)" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--orvyn-surface-2)", border: "1px solid var(--orvyn-border-soft)", borderRadius: 7, padding: "5px 8px" }}>
            <IconSearch size={13} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search help — permissions, terminal, cloud…"
              style={{ flex: 1, background: "transparent", border: "none", color: "var(--orvyn-text)", fontSize: 12.5, outline: "none" }}
            />
          </label>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "10px 14px 20px" }}>
          {topics.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)", padding: 12 }}>No topics match “{query}”.</div>
          )}
          {topics.map((t) => (
            <article key={t.id} style={{ marginBottom: 16 }}>
              <h3 style={{ margin: "0 0 6px", fontSize: 13, fontWeight: 650 }}>{t.title}</h3>
              <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: "var(--orvyn-text-secondary)" }}>{t.body}</p>
            </article>
          ))}
        </div>
      </aside>
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  marginLeft: "auto",
  background: "transparent",
  border: "none",
  color: "var(--orvyn-text-muted)",
  width: 28,
  height: 28,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
};
