// apps/desktop/src/renderer/components/Navigation.tsx
//
// The approved mockup's left navigation: a labeled, sectioned list rather
// than an icon rail. Every item routes to a real workspace; items whose
// backing capability does not exist yet route to an HonestState screen that
// says so — nothing here is decorative.
import React from "react";
import {
  IconAgents,
  IconBox,
  IconCard,

  IconCloud,
  IconCode,
  IconDatabase,
  IconFolder,
  IconGit,
  IconGlobe,
  IconHome,
  IconList,
  IconReport,
  IconRocket,
  IconSearch,
  IconServer,
  IconSettings,
  IconSparkles,
  IconTerminal,
  IconWrench,
  IconZap,
} from "./Icons";

export type ViewId =
  | "home"
  | "newtask"
  | "missions"
  | "automations"
  | "projects"
  | "editor"
  | "terminal"
  | "browser"
  | "servers"
  | "containers"
  | "databases"
  | "cloud"
  | "agents"
  | "models"
  | "tools"
  | "chats"
  | "search"
  | "scm"
  | "usage"
  | "billing"
  | "settings";

interface NavItem {
  id: ViewId;
  label: string;
  Icon: React.FC<{ size?: number }>;
}

interface NavSection {
  title?: string;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    items: [
      { id: "home", label: "Home", Icon: IconHome },
      { id: "newtask", label: "New Task", Icon: IconRocket },
      { id: "missions", label: "Missions", Icon: IconList },
      { id: "automations", label: "Automations", Icon: IconZap },
    ],
  },
  {
    title: "WORK",
    items: [
      { id: "projects", label: "Projects", Icon: IconFolder },
      { id: "editor", label: "Code", Icon: IconCode },
      { id: "terminal", label: "Terminal", Icon: IconTerminal },
      { id: "browser", label: "Browser", Icon: IconGlobe },
    ],
  },
  {
    title: "INFRASTRUCTURE",
    items: [
      { id: "servers", label: "Servers", Icon: IconServer },
      { id: "containers", label: "Containers", Icon: IconBox },
      { id: "databases", label: "Databases", Icon: IconDatabase },
      { id: "cloud", label: "Cloud", Icon: IconCloud },
    ],
  },
  {
    title: "AI",
    items: [
      { id: "agents", label: "Agents", Icon: IconAgents },
      { id: "models", label: "Models", Icon: IconSparkles },
      { id: "tools", label: "Tools & MCP", Icon: IconWrench },
    ],
  },
  {
    title: "ACCOUNT",
    items: [
      { id: "usage", label: "Usage & Credits", Icon: IconReport },
      { id: "billing", label: "Billing", Icon: IconCard },
      { id: "settings", label: "Settings", Icon: IconSettings },
    ],
  },
];

export function Navigation({
  view,
  onChange,
  chatActive,
  onFocusChat,
}: {
  view: ViewId;
  onChange: (v: ViewId) => void;
  chatActive?: boolean;
  onFocusChat?: () => void;
}) {
  return (
    <div
      style={{
        width: 222,
        flexShrink: 0,
        background: "var(--orvyn-surface-1)",
        borderRight: "1px solid var(--orvyn-border-soft)",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
        paddingBottom: 10,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {SECTIONS.map((section, si) => {
          const isAccount = section.title === "ACCOUNT";
          return (
            <div key={si} style={{ marginTop: section.title ? 12 : 6, ...(isAccount ? { marginTop: "auto", paddingTop: 12 } : {}) }}>
              {section.title && (
                <div
                  style={{
                    fontSize: 9.5,
                    fontWeight: 700,
                    letterSpacing: 1.4,
                    color: "var(--orvyn-text-muted)",
                    padding: "4px 18px",
                  }}
                >
                  {section.title}
                </div>
              )}
              {section.items.map(({ id, label, Icon }) => (
                <NavItemButton key={id} label={label} active={view === id} onClick={() => onChange(id)} Icon={Icon} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NavItemButton({
  label,
  active,
  onClick,
  Icon,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  Icon: React.FC<{ size?: number }>;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        width: "100%",
        padding: "6.5px 16px",
        background: active ? "rgba(108,92,255,0.12)" : "transparent",
        border: "none",
        borderLeft: active ? "2.5px solid var(--orvyn-purple)" : "2.5px solid transparent",
        color: active ? "var(--orvyn-text)" : "var(--orvyn-text-secondary)",
        fontSize: 12.5,
        textAlign: "left",
        cursor: "pointer",
        transition: "background 130ms ease, color 130ms ease",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--orvyn-surface-2)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
    >
      <span style={{ color: active ? "var(--orvyn-purple-hi)" : undefined, display: "inline-flex" }}>
        <Icon size={15} />
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
    </button>
  );
}

// Kept for the editor sub-bar / palette: icons that previously lived only in
// the ActivityBar remain importable from here.
export { IconGit, IconSearch };
