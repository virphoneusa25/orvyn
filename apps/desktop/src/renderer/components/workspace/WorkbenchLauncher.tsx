import React from "react";
import { WORKBENCH_LAUNCHERS } from "../../workbenchModel";
import { IconFile, IconGit, IconGlobe, IconTerminal } from "../Icons";

const ICONS = {
  changes: IconGit,
  browser: IconGlobe,
  terminal: IconTerminal,
  files: IconFile,
} as const;

const DISPLAY_ORDER = ["files", "browser", "terminal", "changes"] as const;

export function WorkbenchLauncher({ onOpen }: { onOpen: (id: (typeof WORKBENCH_LAUNCHERS)[number]["id"]) => void }) {
  const cards = DISPLAY_ORDER.map((id) => WORKBENCH_LAUNCHERS.find((card) => card.id === id)).filter((card): card is (typeof WORKBENCH_LAUNCHERS)[number] => Boolean(card));
  return (
    <div
      data-testid="workbench-launcher"
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "var(--orvyn-surface-1, #070b14)",
      }}
    >
      <div style={{ width: "min(440px, 100%)", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {cards.map((card) => {
          const Icon = ICONS[card.id];
          return (
            <button
              key={card.id}
              data-launcher={card.id}
              onClick={() => onOpen(card.id)}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                minHeight: 72,
                padding: "12px 12px",
                background: "rgba(8,12,22,0.72)",
                border: "1px solid var(--orvyn-border-soft)",
                borderRadius: 8,
                color: "var(--orvyn-text)",
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <span style={{ color: "var(--orvyn-cyan)", display: "inline-flex", marginTop: 1, flexShrink: 0 }}><Icon size={16} /></span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>{card.label}</span>
                <span style={{ display: "block", fontSize: 12, lineHeight: 1.4, color: "var(--orvyn-text-muted)", marginTop: 3 }}>{card.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
