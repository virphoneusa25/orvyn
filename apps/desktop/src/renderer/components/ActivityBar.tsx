// apps/desktop/src/renderer/components/ActivityBar.tsx
import React from "react";
import { IconChat, IconFiles, IconPlus, IconSearch, IconSparkles, IconSettings } from "./Icons";

export type ViewId = "editor" | "search" | "models" | "settings";

const ITEMS: { id: ViewId; label: string; Icon: React.FC<{ size?: number }> }[] = [
  { id: "editor", label: "Explorer", Icon: IconFiles },
  { id: "search", label: "Search & RAG", Icon: IconSearch },
  { id: "models", label: "AI Models", Icon: IconSparkles },
];

export function ActivityBar({
  view,
  onChange,
  chatActive,
  onFocusChat,
  onNewChat,
}: {
  view: ViewId;
  onChange: (v: ViewId) => void;
  chatActive?: boolean;
  onFocusChat?: () => void;
  onNewChat?: () => void;
}) {
  return (
    <div
      style={{
        width: 48,
        background: "var(--bg-app)",
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        paddingTop: 6,
        flexShrink: 0,
      }}
    >
      <Item label="Chat" active={!!chatActive} onClick={() => onFocusChat?.()}>
        <IconChat size={19} />
      </Item>
      {ITEMS.map(({ id, label, Icon }) => (
        <Item key={id} label={label} active={view === id} onClick={() => onChange(id)}>
          <Icon size={19} />
        </Item>
      ))}

      <div style={{ marginTop: "auto", paddingBottom: 6 }}>
        {onNewChat && (
          <Item label="New chat" active={false} onClick={onNewChat}>
            <IconPlus size={19} />
          </Item>
        )}
        <Item label="Settings" active={view === "settings"} onClick={() => onChange("settings")}>
          <IconSettings size={19} />
        </Item>
      </div>
    </div>
  );
}

function Item({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      style={{
        position: "relative",
        width: 48,
        height: 44,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: "none",
        color: active ? "var(--text)" : "var(--text-muted)",
        transition: "color 120ms ease",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.color = "var(--text-secondary)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.color = "var(--text-muted)";
      }}
    >
      <span
        style={{
          position: "absolute",
          left: 0,
          top: 10,
          bottom: 10,
          width: 2,
          borderRadius: 1,
          background: active ? "var(--accent)" : "transparent",
        }}
      />
      {children}
    </button>
  );
}
