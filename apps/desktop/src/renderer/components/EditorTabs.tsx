// apps/desktop/src/renderer/components/EditorTabs.tsx
import React from "react";
import { IconClose, IconFile } from "./Icons";

export interface OpenTab {
  path: string;
  dirty?: boolean;
}

export function EditorTabs({
  tabs,
  activePath,
  onSelect,
  onClose,
}: {
  tabs: OpenTab[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}) {
  if (tabs.length === 0) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "stretch",
        background: "var(--bg-app)",
        borderBottom: "1px solid var(--border)",
        overflowX: "auto",
        minHeight: 35,
      }}
    >
      {tabs.map((tab) => {
        const active = tab.path === activePath;
        const name = tab.path.split(/[\\/]/).pop() ?? tab.path;
        return (
          <div
            key={tab.path}
            onClick={() => onSelect(tab.path)}
            title={tab.path}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "0 10px 0 12px",
              background: active ? "var(--bg-panel)" : "transparent",
              borderRight: "1px solid var(--border)",
              // The top accent is how VS Code / Cursor signal the active tab
              borderTop: `2px solid ${active ? "var(--accent)" : "transparent"}`,
              color: active ? "var(--text)" : "var(--text-secondary)",
              cursor: "pointer",
              whiteSpace: "nowrap",
              fontSize: 12.5,
            }}
          >
            <IconFile size={13} />
            <span>{name}</span>
            {tab.dirty && (
              <span
                title="Unsaved changes"
                style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)" }}
              />
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.path);
              }}
              aria-label={`Close ${name}`}
              style={{
                display: "flex",
                alignItems: "center",
                background: "transparent",
                border: "none",
                color: "var(--text-muted)",
                padding: 2,
                borderRadius: 3,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <IconClose size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
