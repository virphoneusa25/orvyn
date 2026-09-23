import React from "react";
import { WORKBENCH_LAUNCHERS } from "../../workbenchModel";
import { IconFile, IconGit, IconGlobe, IconTerminal } from "../Icons";

const ICONS = {
  changes: IconGit,
  browser: IconGlobe,
  terminal: IconTerminal,
  files: IconFile,
} as const;

export function WorkbenchLauncher({ onOpen }: { onOpen: (id: (typeof WORKBENCH_LAUNCHERS)[number]["id"]) => void }) {
  return (
    <div data-testid="workbench-launcher" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 28 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, width: "min(420px, 100%)" }}>
        {WORKBENCH_LAUNCHERS.map((card) => {
          const Icon = ICONS[card.id];
          return (
            <button
              key={card.id}
              data-launcher={card.id}
              onClick={() => onOpen(card.id)}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: 8,
                minHeight: 108,
                padding: "18px 16px",
                background: "var(--orvyn-surface-2)",
                border: "1px solid var(--orvyn-border-soft)",
                borderRadius: 12,
                color: "var(--orvyn-text)",
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <Icon size={18} />
              <span style={{ fontSize: 15, fontWeight: 650 }}>{card.label}</span>
              <span style={{ fontSize: 11, lineHeight: 1.45, color: "var(--orvyn-text-muted)" }}>{card.hint}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
