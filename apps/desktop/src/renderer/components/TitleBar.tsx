// apps/desktop/src/renderer/components/TitleBar.tsx
//
// Replaces the native Windows chrome. One bar carries the app mark, the
// File/Edit/View/Window/Help menus, the centred document title, and the
// min/max/close controls — the VS Code / Cursor arrangement.
//
// Dragging works via `-webkit-app-region: drag` on the bar; every interactive
// element must opt out with `no-drag` or it becomes un-clickable.
import React, { useEffect, useRef, useState } from "react";
import appIcon from "../assets/icon.png";
import { AccountCluster } from "./AccountCluster";

export interface MenuItem {
  label?: string;
  accelerator?: string;
  onClick?: () => void;
  separator?: boolean;
  disabled?: boolean;
}

export interface Menu {
  label: string;
  items: MenuItem[];
}

export function TitleBar({
  menus,
  title,
  usageLabel,
  usageTitle,
  planLabel,
  onOpenCommand,
  onOpenSettings,
  onSwitchWorkspace,
}: {
  menus: Menu[];
  title?: string;
  /** Real usage summary for the header chip (e.g. tokens this month). */
  usageLabel?: string | null;
  usageTitle?: string;
  /** Real plan/mode label; omit when there is no account backend. */
  planLabel?: string | null;
  onOpenCommand?: () => void;
  onOpenSettings?: () => void;
  onSwitchWorkspace?: () => void;
}) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.orvyn.window.isMaximized().then(setMaximized);
    return window.orvyn.window.onMaximizedChange(setMaximized);
  }, []);

  // Click-away and Escape close the menu, matching native behaviour.
  useEffect(() => {
    if (!openMenu) return;
    function onDown(e: MouseEvent) {
      if (!barRef.current?.contains(e.target as Node)) setOpenMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenMenu(null);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [openMenu]);

  return (
    <div
      ref={barRef}
      className="drag-region"
      style={{
        height: "var(--orvyn-topbar-height)",
        display: "flex",
        alignItems: "center",
        background: "var(--orvyn-surface-1)",
        borderBottom: "1px solid var(--orvyn-border-soft)",
        userSelect: "none",
        position: "relative",
        flexShrink: 0,
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", paddingLeft: 8, gap: 2 }} className="no-drag">
        <img
          src={appIcon}
          alt="ORVYN"
          width={20}
          height={20}
          className="no-drag"
          style={{
            borderRadius: 5,
            marginRight: 7,
            display: "block",
            background: "#161B2C",
            WebkitAppRegion: "no-drag",
          } as React.CSSProperties}
        />
        <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.1, marginRight: 10 }}>
          <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 0.8, color: "var(--orvyn-text)" }}>
            ORVYN
          </span>
          <span style={{ fontSize: 8.5, letterSpacing: 0.4, color: "var(--orvyn-text-muted)" }}>
            Your AI Co-Worker
          </span>
        </span>

        {menus.map((menu) => (
          <div key={menu.label} style={{ position: "relative" }} className="no-drag">
            <button
              onClick={() => setOpenMenu(openMenu === menu.label ? null : menu.label)}
              // Hovering another top-level menu while one is open switches to it,
              // which is what native menu bars do.
              onMouseEnter={() => openMenu && setOpenMenu(menu.label)}
              style={{
                background: openMenu === menu.label ? "var(--bg-active)" : "transparent",
                border: "none",
                color: "var(--text-secondary)",
                padding: "4px 9px",
                fontSize: 12,
                borderRadius: 4,
              }}
            >
              {menu.label}
            </button>

            {openMenu === menu.label && (
              <div
                style={{
                  position: "absolute",
                  top: 28,
                  left: 0,
                  minWidth: 220,
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border-strong)",
                  borderRadius: 6,
                  boxShadow: "var(--orvyn-shadow)",
                  padding: 4,
                  zIndex: 500,
                }}
              >
                {menu.items.map((item, i) =>
                  item.separator ? (
                    <div key={i} style={{ height: 1, background: "var(--border)", margin: "4px 6px" }} />
                  ) : (
                    <button
                      key={i}
                      disabled={item.disabled}
                      onClick={() => {
                        setOpenMenu(null);
                        item.onClick?.();
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        width: "100%",
                        background: "transparent",
                        border: "none",
                        color: item.disabled ? "var(--text-muted)" : "var(--text)",
                        padding: "5px 9px",
                        fontSize: 12.5,
                        borderRadius: 4,
                        textAlign: "left",
                      }}
                      onMouseEnter={(e) => {
                        if (!item.disabled) e.currentTarget.style.background = "var(--bg-hover)";
                      }}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      <span>{item.label}</span>
                      {item.accelerator && (
                        <span style={{ marginLeft: "auto", paddingLeft: 24, color: "var(--text-muted)", fontSize: 11 }}>
                          {item.accelerator}
                        </span>
                      )}
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Center: the mockup's command/search bar. It opens the real command
          palette — search is a navigation surface, not a fake input. The
          shortcut chip shows the binding that actually opens it (Ctrl+K is
          the editor's inline edit and stays untouched). */}
      <div style={{ flex: 1, display: "flex", justifyContent: "center", minWidth: 0 }}>
        <button
          className="no-drag"
          onClick={() => onOpenCommand?.()}
          title="Open command palette"
          style={{
            width: "min(480px, 38vw)",
            height: 28,
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "var(--orvyn-surface-2)",
            border: "1px solid var(--orvyn-border-soft)",
            borderRadius: "var(--orvyn-radius-md)",
            color: "var(--orvyn-text-muted)",
            fontSize: 12,
            padding: "0 10px",
            cursor: "pointer",
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m16 16 4.5 4.5" strokeLinecap="round" />
          </svg>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            Ask ORVYN to build, fix, deploy, research, or run a task…
          </span>
          <span
            style={{
              marginLeft: "auto",
              fontSize: 10,
              border: "1px solid var(--orvyn-border)",
              borderRadius: 4,
              padding: "1px 6px",
              color: "var(--orvyn-text-muted)",
              flexShrink: 0,
            }}
          >
            Ctrl+Shift+P
          </span>
        </button>
      </div>

      {/* Right: approved account presentation with truthful local state.
          No fabricated credit balance or user identity — the capsules keep
          the approved shape and carry what is real: metered usage and mode. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, paddingRight: 6 }} className="no-drag">
        {usageLabel && (
          <span
            title={usageTitle ?? usageLabel}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              color: "var(--orvyn-text-secondary)",
              background: "var(--orvyn-surface-2)",
              border: "1px solid var(--orvyn-border-soft)",
              borderRadius: 999,
              padding: "3px 11px",
              whiteSpace: "nowrap",
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--orvyn-cyan)" }} />
            {usageLabel}
          </span>
        )}
        {planLabel && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "#fff",
              background: "var(--orvyn-purple)",
              borderRadius: 999,
              padding: "3px 11px",
              whiteSpace: "nowrap",
            }}
          >
            {planLabel}
          </span>
        )}
        <button
          title="Notifications — none"
          style={{
            background: "transparent",
            border: "none",
            color: "var(--orvyn-text-muted)",
            cursor: "default",
            display: "inline-flex",
            padding: 4,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6" strokeLinecap="round" />
            <path d="M10.3 19a2 2 0 0 0 3.4 0" strokeLinecap="round" />
          </svg>
        </button>
        <span style={{ width: 1, height: 16, background: "var(--orvyn-border)" }} />
        <AccountCluster onOpenSettings={onOpenSettings} onSwitchWorkspace={onSwitchWorkspace} />
        <span style={{ width: 1, height: 16, background: "var(--orvyn-border)" }} />
      </div>

      <div style={{ display: "flex", height: "100%" }} className="no-drag">
        <WinButton onClick={() => window.orvyn.window.minimize()} label="Minimize">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" strokeWidth="1" /></svg>
        </WinButton>
        <WinButton onClick={() => window.orvyn.window.toggleMaximize().then(setMaximized)} label="Maximize">
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
              <path d="M2.5 2.5V0.5h7v7h-2" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </WinButton>
        <WinButton onClick={() => window.orvyn.window.close()} label="Close" danger>
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </WinButton>
      </div>
    </div>
  );
}

function WinButton({
  onClick,
  label,
  danger,
  children,
}: {
  onClick: () => void;
  label: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        width: 46,
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: "none",
        color: "var(--text-secondary)",
        transition: "background 120ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = danger ? "#E81123" : "var(--bg-hover)";
        e.currentTarget.style.color = danger ? "#fff" : "var(--text)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "var(--text-secondary)";
      }}
    >
      {children}
    </button>
  );
}
