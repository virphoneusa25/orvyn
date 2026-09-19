// apps/desktop/src/renderer/components/ActivityBar.tsx
import React from "react";
import {
  IconAgents,
  IconChat,
  IconCode,
  IconGit,
  IconPlus,
  IconReport,
  IconSearch,
  IconSparkles,
  IconSettings,
} from "./Icons";
import appIcon from "../assets/icon.png";

export type ViewId = "editor" | "chats" | "search" | "scm" | "agents" | "reports" | "models" | "settings";

// Ordering mirrors the reference nav — Chats, Agents, Programming (the coding
// workspace), Reports — with ORVYN's extras kept after them.
const ITEMS: { id: ViewId; label: string; Icon: React.FC<{ size?: number }> }[] = [
  { id: "chats", label: "Chats", Icon: IconChat },
  { id: "agents", label: "Agents & Missions", Icon: IconAgents },
  { id: "editor", label: "Programming", Icon: IconCode },
  { id: "reports", label: "Reports", Icon: IconReport },
  { id: "search", label: "Search & RAG", Icon: IconSearch },
  { id: "scm", label: "Source Control", Icon: IconGit },
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
        paddingTop: 8,
        flexShrink: 0,
      }}
    >
      <img
        src={appIcon}
        alt="ORVYN"
        width={22}
        height={22}
        title="ORVYN"
        style={{ borderRadius: 6, marginBottom: 8, display: "block", background: "#161B2C" }}
      />
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
