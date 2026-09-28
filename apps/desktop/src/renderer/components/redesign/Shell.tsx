// apps/desktop/src/renderer/components/redesign/Shell.tsx
// Sidebar (full + collapsed rail), top bar, and status footer.
// Sidebar takes the same `view` / `onChange` contract as the existing
// Navigation component, so it can replace it in App.tsx.
import React, { useEffect, useState } from "react";
import type { ViewId } from "../Navigation";
import { Icon, IconName } from "./icons";
import type { EngineStatus, UsageInfo, UserInfo, WorkspaceInfo } from "./types";
import orvynMark from "../../assets/icon.png";
import { getDesktopLayout, setDesktopLayout, WORKBENCH_VIEWS } from "../../desktopLayout";
import type { AgentWorkspaceTab } from "../../agentWorkspaceModel";
import { describeConnection } from "../../connectionState";
import { getConnectionFacts, onConnectionFacts } from "../../connectionRuntime";
import { readComposerDefaults } from "../../composerSettings";
import { customerModelName } from "../../presentationReducer";

type WorkbenchNav = "files" | "changes" | "terminal" | "browser" | "environment";

interface NavEntry {
  id: ViewId | WorkbenchNav;
  label: string;
  icon: IconName;
  /** Workbench tabs stay on the mission and open the right-hand pane. */
  workbench?: WorkbenchNav;
}

const NAV: { label: string; items: NavEntry[] }[] = [
  {
    label: "",
    items: [
      { id: "home", label: "Home", icon: "home" },
      { id: "chats", label: "Chats", icon: "chat" },
      { id: "projects", label: "Projects", icon: "folder" },
      { id: "missions", label: "Missions", icon: "missions" },
      { id: "automations", label: "Automations", icon: "bolt" },
    ],
  },
  {
    label: "Workspace",
    items: [
      { id: "editor", label: "Code", icon: "code" },
      { id: "terminal", label: "Terminal", icon: "terminal", workbench: "terminal" },
      { id: "browser", label: "Browser", icon: "globe", workbench: "browser" },
      { id: "files", label: "Files", icon: "folder", workbench: "files" },
      { id: "changes", label: "Changes", icon: "git", workbench: "changes" },
    ],
  },
  {
    label: "Resources",
    items: [
      { id: "tools", label: "MCP Servers", icon: "plug" },
      { id: "skills", label: "Skills", icon: "spark" },
      { id: "models", label: "AI Models", icon: "cpu" },
      { id: "environment", label: "Environments", icon: "server", workbench: "environment" },
    ],
  },
  {
    label: "Infrastructure",
    items: [
      { id: "servers", label: "Servers", icon: "server" },
      { id: "containers", label: "Containers", icon: "box" },
      { id: "databases", label: "Databases", icon: "database" },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { id: "agents", label: "Agents", icon: "agent" },
      { id: "memory", label: "Memory", icon: "database" },
      { id: "learning", label: "Learning", icon: "cpu" },
    ],
  },
];

const RAIL: { id: ViewId; label: string; icon: IconName }[] = [
  { id: "home", label: "Home", icon: "home" },
  { id: "projects", label: "Projects", icon: "folder" },
  { id: "missions", label: "Missions", icon: "missions" },
  { id: "editor", label: "Code", icon: "code" },
  { id: "terminal", label: "Terminal", icon: "terminal" },
  { id: "servers", label: "Servers", icon: "server" },
  { id: "agents", label: "Agents", icon: "agent" },
  { id: "skills", label: "Skills", icon: "spark" },
];

export interface SidebarProps {
  view: ViewId;
  onChange: (v: ViewId) => void;
  workspace: WorkspaceInfo;
  user: UserInfo;
  usage: UsageInfo;
  /** Count shown on "Missions" (missions waiting on the user). 0 hides it. */
  missionsNeedingYou?: number;
  onNewMission?: () => void;
  onSwitchWorkspace?: () => void;
  onOpenSettings?: () => void;
  onOpenUsage?: () => void;
}

function openWorkbenchTab(tab: WorkbenchNav) {
  const current = getDesktopLayout();
  const openTabIds = current.openTabIds.includes(tab) ? current.openTabIds : [...current.openTabIds, tab];
  setDesktopLayout({
    rightPanelOpen: true,
    activeTab: tab as AgentWorkspaceTab,
    activeTabId: tab,
    openTabIds,
  });
  document.dispatchEvent(new CustomEvent("orvyn:context-open", { detail: { tab } }));
}

export function Sidebar(props: SidebarProps) {
  const { view, onChange, workspace, missionsNeedingYou = 0 } = props;
  const [cloudLabel, setCloudLabel] = useState("Local mode");
  const [cloudOn, setCloudOn] = useState(false);
  const [modelLine, setModelLine] = useState("Auto");
  useEffect(() => onConnectionFacts((facts) => {
    const viewState = describeConnection(facts);
    const on = viewState.signedIn && viewState.modeLabel === "Cloud";
    setCloudOn(on);
    setCloudLabel(on ? "Cloud Connected" : viewState.modeLabel === "Cloud" ? "Cloud offline" : "Local mode");
  }), []);
  useEffect(() => {
    const sync = () => {
      const model = readComposerDefaults().modelId;
      setModelLine(!model || model === "auto" ? "Auto" : customerModelName(model) || "Auto");
    };
    sync();
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
  }, [view]);

  return (
    <nav className="ov-sidebar" aria-label="Primary">
      <button type="button" className="ov-workspace" onClick={props.onSwitchWorkspace ?? (() => onChange("projects"))}>
        <span className="ov-workspace__badge">{(workspace.name || "W").charAt(0).toUpperCase()}</span>
        <span className="ov-workspace__text">
          <span className="ov-workspace__name">{workspace.name}</span>
          <span className="ov-workspace__sub">{workspace.subtitle || "Personal Workspace"}</span>
        </span>
        <Icon name="chevronsUpDown" size={14} strokeWidth={2} />
      </button>

      <div className="ov-nav">
        {NAV.map((section, si) => (
          <div className="ov-nav__section" key={si}>
            {section.label && <div className="ov-nav__label">{section.label}</div>}
            {section.items.map((it) => (
              <button
                key={it.id}
                type="button"
                className="ov-nav__item"
                aria-current={!it.workbench && view === it.id ? "page" : undefined}
                onClick={() => {
                  if (it.workbench) {
                    openWorkbenchTab(it.workbench);
                    if (!WORKBENCH_VIEWS.has(view)) onChange("home");
                    return;
                  }
                  onChange(it.id as ViewId);
                }}
              >
                <Icon name={it.icon} size={17} />
                <span>{it.label}</span>
                {it.id === "missions" && missionsNeedingYou > 0 && (
                  <span className="ov-nav__badge">{missionsNeedingYou}</span>
                )}
              </button>
            ))}
          </div>
        ))}
      </div>

      <button type="button" className="ov-model" onClick={() => onChange("models")}>
        <span className="ov-model__mark">A</span>
        <span className="ov-model__text">
          <span className="ov-model__name">{modelLine}</span>
          <span className="ov-model__sub">{modelLine === "Auto" ? "Best model for your task" : "Active model"}</span>
        </span>
      </button>
      <div className="ov-sidefoot">
        <span className="ov-sidefoot__cloud">
          <span className="ov-dot ov-dot--sm" style={{ background: cloudOn ? "var(--ov-green)" : "var(--ov-faint)" }} />
          {cloudLabel}
        </span>
        <span>v0.1.0</span>
      </div>
    </nav>
  );
}

export function IconRail({ view, onChange }: { view: ViewId; onChange: (v: ViewId) => void }) {
  return (
    <nav className="ov-rail" aria-label="Primary">
      <img src={orvynMark} alt="ORVYN" />
      {RAIL.map((it) => (
        <button
          key={it.id}
          type="button"
          className="ov-rail__item"
          aria-label={it.label}
          title={it.label}
          aria-current={view === it.id ? "page" : undefined}
          onClick={() => onChange(it.id)}
        >
          <Icon name={it.icon} size={18} />
        </button>
      ))}
    </nav>
  );
}

export interface TopBarProps {
  crumbs: string[];
  status: EngineStatus;
  onOpenCommand?: () => void;
  onReconnectCloud?: () => void;
  onOpenNotifications?: () => void;
}

export function TopBar({ crumbs, status, onOpenCommand, onReconnectCloud, onOpenNotifications }: TopBarProps) {
  return (
    <header className="ov-topbar">
      <div className="ov-crumbs">
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="ov-crumbs__sep">/</span>}
            <span className={i === crumbs.length - 1 ? "ov-crumbs__current" : undefined}>{c}</span>
          </React.Fragment>
        ))}
      </div>

      <button type="button" className="ov-search" onClick={onOpenCommand}>
        <Icon name="search" size={15} strokeWidth={1.8} />
        <span>Search missions, files, servers, or run a command</span>
        <span className="ov-search__kbd">Ctrl K</span>
      </button>

      <div className="ov-topbar__right">
        {status.engineReady ? (
          <span className="ov-pill ov-pill--ok" title="Local engine ready">
            <span className="ov-dot" />
            <span className="ov-pill__full">Local engine ready</span>
            <span className="ov-pill__compact">Local</span>
          </span>
        ) : (
          <span className="ov-pill ov-pill--warn" title="Local engine starting">
            <span className="ov-dot" />
            <span className="ov-pill__full">Local engine starting</span>
            <span className="ov-pill__compact">Local</span>
          </span>
        )}
        {!status.cloudOnline && (
          <button type="button" className="ov-pill ov-pill--warn" onClick={onReconnectCloud} title="Cloud offline — reconnect">
            <span className="ov-dot" />
            <span className="ov-pill__full">Cloud offline · Reconnect</span>
            <span className="ov-pill__compact">Cloud</span>
          </button>
        )}
        <button type="button" className="ov-icon-btn" aria-label="Notifications" onClick={onOpenNotifications}>
          <Icon name="bell" size={16} />
        </button>
      </div>
    </header>
  );
}

export function StatusFooter({ status, onOpenTerminal }: { status: EngineStatus; onOpenTerminal?: () => void }) {
  const pct = (n?: number) => (n == null ? "—" : `${Math.round(n)}%`);
  return (
    <footer className="ov-footer">
      <span className="ov-footer__item">
        <span className="ov-dot ov-dot--sm" style={{ background: status.engineReady ? "var(--ov-green)" : "var(--ov-amber)" }} />
        {status.engineReady ? "engine ready" : "engine starting"}
      </span>
      <span className="ov-footer__item">
        <span className="ov-dot ov-dot--sm" style={{ background: status.cloudOnline ? "var(--ov-green)" : "var(--ov-amber)" }} />
        {status.cloudOnline ? "cloud online" : "cloud offline"}
      </span>
      {status.lastRun && <span>last run: {status.lastRun}</span>}
      <span className="ov-footer__push">cpu {pct(status.cpu)}</span>
      <span className={status.ram != null && status.ram > 80 ? "ov-footer__warn" : undefined}>ram {pct(status.ram)}</span>
      <span className={status.disk != null && status.disk > 80 ? "ov-footer__warn" : undefined}>disk {pct(status.disk)}</span>
      <span>
        {status.agentsRunning} agent{status.agentsRunning === 1 ? "" : "s"} running
      </span>
      <button type="button" onClick={onOpenTerminal}>
        Terminal Ctrl `
      </button>
    </footer>
  );
}
