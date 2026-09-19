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

export function TitleBar({ menus, title }: { menus: Menu[]; title?: string }) {
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
        height: 34,
        display: "flex",
        alignItems: "center",
        background: "var(--bg-app)",
        borderBottom: "1px solid var(--border)",
        userSelect: "none",
        position: "relative",
        flexShrink: 0,
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
            marginRight: 6,
            display: "block",
            background: "#161B2C",
            WebkitAppRegion: "no-drag",
          } as React.CSSProperties}
        />
        <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 0.5, color: "var(--text)", marginRight: 8 }}>
          ORVYN
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
                  top: 26,
                  left: 0,
                  minWidth: 220,
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border-strong)",
                  borderRadius: 6,
                  boxShadow: "0 12px 32px rgba(0,0,0,0.55)",
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

      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: 11.5,
          color: "var(--text-muted)",
          pointerEvents: "none",
        }}
      >
        {title}
      </div>

      <div style={{ marginLeft: "auto", display: "flex", height: "100%" }} className="no-drag">
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
