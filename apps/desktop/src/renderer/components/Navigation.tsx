// apps/desktop/src/renderer/components/Navigation.tsx
//
// The approved mockup's left navigation: a labeled, sectioned list rather
// than an icon rail. Every item routes to a real workspace; items whose
// backing capability does not exist yet route to an HonestState screen that
// says so — nothing here is decorative.
import React, { useEffect, useState } from "react";
import { apiUrl, authHeaders } from "../connection";
import { getDesktopLayout, setDesktopLayout, subscribeDesktopLayout } from "../desktopLayout";
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
  IconMonitor,
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
  | "desktops"
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
  | "memory"
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
    title: "COMPUTE",
    items: [
      { id: "desktops", label: "Desktops", Icon: IconMonitor },
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
      { id: "memory", label: "Memory", Icon: IconDatabase },
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

/** Desktops is a launcher, not a view: it opens the Workbench's Desktop
 *  tab (persisted so it activates even if the panel mounts after this
 *  click) and lets the context-open event bring the panel up. */
function openDesktopSurface() {
  setDesktopLayout({ rightPanelOpen: true, activeTab: "desktop", activeTabId: "desktop" });
  document.dispatchEvent(new CustomEvent("orvyn:context-open", { detail: { tab: "desktop" } }));
}

export function Navigation({
  view,
  onChange,
  projectRoot,
}: {
  view: ViewId;
  onChange: (v: ViewId) => void;
  projectRoot?: string | null;
}) {
  const [desktopActive, setDesktopActive] = useState(
    () => getDesktopLayout().rightPanelOpen && getDesktopLayout().activeTabId === "desktop",
  );
  useEffect(() => {
    return subscribeDesktopLayout((l) => {
      setDesktopActive(l.rightPanelOpen && l.activeTabId === "desktop");
    });
  }, []);
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
      <div style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minHeight: 0 }}>
        {SECTIONS.map((section, si) => {
          const isAccount = section.title === "ACCOUNT";
          return (
            <div key={si} style={{ marginTop: section.title ? 12 : 6, ...(isAccount ? { marginTop: 18 } : {}) }}>
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
                <NavItemButton
                  key={id}
                  label={label}
                  active={id === "desktops" ? desktopActive : view === id}
                  onClick={id === "desktops" ? openDesktopSurface : () => onChange(id)}
                  Icon={Icon}
                />
              ))}
            </div>
          );
        })}
      </div>
      <CurrentProjectCard projectRoot={projectRoot ?? null} />
    </div>
  );
}

/** The approved Current Project card — real workspace + real git branch. */
function CurrentProjectCard({ projectRoot }: { projectRoot: string | null }) {
  const [branch, setBranch] = useState<string | null>(null);

  useEffect(() => {
    setBranch(null);
    if (!projectRoot) return;
    let alive = true;
    fetch(apiUrl("/tools/git_branch/execute"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ args: {}, approved: true }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        // Output like "* main" — take the current branch line.
        const line = String(d.output ?? "")
          .split("\n")
          .find((l: string) => l.trim().startsWith("*"));
        setBranch(d.ok && line ? line.trim().slice(2).trim() : null);
      })
      .catch(() => {
        if (alive) setBranch(null);
      });
    return () => {
      alive = false;
    };
  }, [projectRoot]);

  const name = projectRoot ? (projectRoot.split(/[\\/]/).pop() ?? null) : null;

  return (
    <div
      style={{
        margin: "14px 10px 0",
        padding: "8px 10px",
        borderRadius: "var(--orvyn-radius-md)",
        background: "var(--orvyn-surface-2)",
        border: "1px solid var(--orvyn-border-soft)",
      }}
    >
      <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 1.2, color: "var(--orvyn-text-muted)" }}>
        CURRENT PROJECT
      </div>
      {name ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
          <span style={{ fontSize: 12, color: "var(--orvyn-text)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {name}
          </span>
          {branch && (
            <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--orvyn-purple-hi)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>
              ⑂ {branch}
            </span>
          )}
        </div>
      ) : (
        <button
          onClick={() => document.dispatchEvent(new CustomEvent("orvyn:nav", { detail: "projects" }))}
          style={{
            marginTop: 4,
            background: "transparent",
            border: "none",
            color: "var(--orvyn-purple-hi)",
            fontSize: 11,
            cursor: "pointer",
            padding: 0,
          }}
        >
          No project open — Open Project
        </button>
      )}
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
