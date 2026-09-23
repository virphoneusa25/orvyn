import React from "react";
import { WORKBENCH_LAUNCHERS } from "../../workbenchModel";
import { IconChevronRight, IconFile, IconGit, IconGlobe, IconTerminal } from "../Icons";

const ICONS = {
  changes: IconGit,
  browser: IconGlobe,
  terminal: IconTerminal,
  files: IconFile,
} as const;

export function WorkbenchLauncher({ onOpen }: { onOpen: (id: (typeof WORKBENCH_LAUNCHERS)[number]["id"]) => void }) {
  return (
    <div
      data-testid="workbench-launcher"
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 32,
        background: "radial-gradient(ellipse at 50% 0%, rgba(77,163,255,0.08), transparent 55%)",
      }}
    >
      <div style={{ fontSize: 22, fontWeight: 650, letterSpacing: -0.3, marginBottom: 8 }}>Open a workspace tool</div>
      <div style={{ fontSize: 13, color: "var(--orvyn-text-muted)", marginBottom: 28, textAlign: "center", maxWidth: 420, lineHeight: 1.5 }}>
        Files, previews, browser sessions, terminal output, and generated artifacts appear here as ORION works.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, width: "min(560px, 100%)" }}>
        {WORKBENCH_LAUNCHERS.map((card) => {
          const Icon = ICONS[card.id];
          return (
            <button
              key={card.id}
              data-launcher={card.id}
              onClick={() => onOpen(card.id)}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 14,
                minHeight: 104,
                padding: "20px 18px",
                background: "linear-gradient(180deg, rgba(17,24,39,0.92), rgba(11,16,27,0.96))",
                border: "1px solid var(--orvyn-border-soft)",
                borderRadius: 14,
                color: "var(--orvyn-text)",
                cursor: "pointer",
                textAlign: "left",
                boxShadow: "0 10px 28px rgba(3,8,18,0.35)",
              }}
            >
              <span style={{ color: "var(--orvyn-cyan)", display: "inline-flex", marginTop: 2 }}><Icon size={20} /></span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 16, fontWeight: 650 }}>{card.label}</span>
                <span style={{ display: "block", fontSize: 12, lineHeight: 1.45, color: "var(--orvyn-text-muted)", marginTop: 6 }}>{card.hint}</span>
              </span>
              <span style={{ color: "var(--orvyn-text-muted)", display: "inline-flex" }}><IconChevronRight size={16} /></span>
            </button>
          );
        })}
      </div>
      <div style={{ marginTop: 28, fontSize: 11, color: "var(--orvyn-text-muted)" }}>One place to work. Powered by ORVYN.</div>
    </div>
  );
}
