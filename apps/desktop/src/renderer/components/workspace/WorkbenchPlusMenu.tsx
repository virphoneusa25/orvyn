import React, { useMemo, useState } from "react";
import {
  IconChat,
  IconFile,
  IconFolder,
  IconGit,
  IconGlobe,
  IconMonitor,
  IconSearch,
  IconSettings,
  IconTerminal,
} from "../Icons";
import type { WorkbenchTabKind } from "../../workbenchModel";
import { WORKBENCH_PLUS_ITEMS } from "../../workbenchModel";

const ICONS: Record<string, React.ComponentType<{ size?: number }>> = {
  files: IconFile,
  terminal: IconTerminal,
  browser: IconGlobe,
  changes: IconGit,
  desktop: IconMonitor,
  environment: IconFolder,
  review: IconSettings,
  subscriptions: IconSettings,
  "side-chat": IconChat,
};

export function WorkbenchPlusMenu({
  query,
  onQuery,
  onSelect,
}: {
  query: string;
  onQuery: (q: string) => void;
  onSelect: (id: string, kind: WorkbenchTabKind | "subscriptions" | "side-chat") => void;
}) {
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return WORKBENCH_PLUS_ITEMS.filter((i) => !q || i.label.toLowerCase().includes(q));
  }, [query]);

  return (
    <div>
      <div style={{ padding: 8, borderBottom: "1px solid var(--orvyn-border-soft)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--orvyn-surface-1)", border: "1px solid var(--orvyn-border-soft)", borderRadius: 8, padding: "6px 8px" }}>
          <IconSearch size={13} />
          <input
            autoFocus
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Open any file, URL, or tool…"
            style={{ flex: 1, background: "transparent", border: "none", color: "var(--orvyn-text)", fontSize: 12, outline: "none" }}
          />
        </div>
      </div>
      <div style={{ padding: 4 }}>
        {items.map((item) => {
          const Icon = ICONS[item.id] ?? IconFile;
          return (
            <button
              key={item.id}
              data-plus-item={item.id}
              onClick={() => {
                if (item.disabled) return;
                onSelect(item.id, item.kind);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                background: "transparent",
                border: "none",
                borderRadius: 8,
                color: "var(--orvyn-text)",
                textAlign: "left",
                fontSize: 13,
                padding: "8px 10px",
                cursor: item.disabled ? "default" : "pointer",
                opacity: item.disabled ? 0.45 : 1,
              }}
              onMouseEnter={(e) => {
                if (!item.disabled) e.currentTarget.style.background = "rgba(77,163,255,0.08)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              <span style={{ color: "var(--orvyn-cyan)", display: "inline-flex" }}><Icon size={14} /></span>
              <span style={{ flex: 1 }}>{item.label}</span>
              {item.shortcut && <span style={{ fontSize: 11, color: "var(--orvyn-text-muted)" }}>{item.shortcut}</span>}
            </button>
          );
        })}
        {items.length === 0 && (
          <div style={{ padding: 12, fontSize: 12, color: "var(--orvyn-text-muted)" }}>No matching tools</div>
        )}
      </div>
    </div>
  );
}

export function usePlusQuery() {
  const [query, setQuery] = useState("");
  return { query, setQuery };
}
