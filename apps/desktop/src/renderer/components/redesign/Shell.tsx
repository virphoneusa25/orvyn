// apps/desktop/src/renderer/components/redesign/Shell.tsx
// Sidebar (full + collapsed rail), top bar, and status footer.
// Sidebar takes the same `view` / `onChange` contract as the existing
// Navigation component, so it can replace it in App.tsx.
import React from "react";
import type { ViewId } from "../Navigation";
import { Icon, IconName } from "./icons";
import type { EngineStatus, UsageInfo, UserInfo, WorkspaceInfo } from "./types";
import orvynMark from "../../assets/icon.png";

interface NavEntry {
  id: ViewId;
  label: string;
  icon: IconName;
}

const NAV: { label: string; items: NavEntry[] }[] = [
  {
    label: "",
    items: [
      { id: "home", label: "Home", icon: "home" },
      { id: "chats", label: "Chats", icon: "globe" },
      { id: "missions", label: "Missions", icon: "missions" },
      { id: "automations", label: "Automations", icon: "bolt" },
    ],
  },
  {
    label: "Workspace",
    items: [
      { id: "editor", label: "Code", icon: "code" },
      { id: "terminal", label: "Terminal", icon: "terminal" },
      { id: "browser", label: "Browser", icon: "globe" },
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
      { id: "models", label: "Models", icon: "cpu" },
      { id: "tools", label: "Tools & MCP", icon: "plug" },
      { id: "memory", label: "Memory", icon: "database" },
    ],
  },
];

const RAIL: NavEntry[] = [
  { id: "home", label: "Home", icon: "home" },
  { id: "missions", label: "Missions", icon: "missions" },
  { id: "editor", label: "Code", icon: "code" },
  { id: "terminal", label: "Terminal", icon: "terminal" },
  { id: "servers", label: "Servers", icon: "server" },
  { id: "agents", label: "Agents", icon: "agent" },
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

export function Sidebar(props: SidebarProps) {
  const { view, onChange, workspace, user, usage, missionsNeedingYou = 0 } = props;
  return (
    <nav className="ov-sidebar" aria-label="Primary">
      <div className="ov-brand">
        <img src={orvynMark} alt="" />
        <span>ORVYN</span>
      </div>

      <button type="button" className="ov-workspace" onClick={props.onSwitchWorkspace}>
        <span className="ov-workspace__badge">{workspace.name.charAt(0).toUpperCase()}</span>
        <span className="ov-workspace__text">
          <span className="ov-workspace__name">{workspace.name}</span>
          <span className="ov-workspace__sub">{workspace.subtitle}</span>
        </span>
        <Icon name="chevronsUpDown" size={14} strokeWidth={2} />
      </button>

      <button type="button" className="ov-new-mission" onClick={props.onNewMission}>
        <Icon name="plus" size={15} strokeWidth={2.2} />
        New mission
        <span className="ov-kbd">Ctrl N</span>
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
                aria-current={view === it.id ? "page" : undefined}
                onClick={() => onChange(it.id)}
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

      <div className="ov-usage">
        <div className="ov-usage__row">
          <span className="ov-usage__label">Tokens this cycle</span>
          <span className="ov-usage__value">{usage.valueLabel}</span>
        </div>
        <div className="ov-meter">
          <div style={{ width: `${Math.min(100, Math.max(0, usage.percent))}%` }} />
        </div>
        <div className="ov-usage__foot">
          <span>{usage.limitLabel}</span>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              props.onOpenUsage?.();
            }}
          >
            Usage →
          </a>
        </div>
      </div>

      <div className="ov-user">
        <span className="ov-avatar">{user.name.charAt(0).toUpperCase()}</span>
        <span className="ov-user__text">
          <span className="ov-user__name">{user.name}</span>
          <span className="ov-user__sub">{user.subtitle}</span>
        </span>
        <button type="button" className="ov-icon-btn" aria-label="Settings" onClick={props.onOpenSettings}>
          <Icon name="settings" size={16} />
        </button>
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
          <span className="ov-pill ov-pill--ok">
            <span className="ov-dot" />
            Local engine ready
          </span>
        ) : (
          <span className="ov-pill ov-pill--warn">
            <span className="ov-dot" />
            Local engine starting
          </span>
        )}
        {!status.cloudOnline && (
          <button type="button" className="ov-pill ov-pill--warn" onClick={onReconnectCloud}>
            <span className="ov-dot" />
            Cloud offline · Reconnect
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
