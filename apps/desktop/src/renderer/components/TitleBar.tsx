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
import type { TranscriptInput } from "../shareTranscript";
import { apiUrl, authHeaders, healthUrl } from "../connection";
import { PlansPanel } from "../onboarding/OnboardingFlow";
import "../onboarding/onboarding.css";

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
  workspaceName?: string | null;
  rightPanelOpen?: boolean;
  onToggleRightPanel?: () => void;
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
  helpOpen?: boolean;
  onToggleHelp?: () => void;
  shareTranscript?: TranscriptInput;
  shareDiagnostics?: { runId?: string | null; backendHost?: string; workspaceName?: string | null; engineState?: string; cloudMode?: boolean };
}) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [accountPlan, setAccountPlan] = useState<string | null>(null);
  const [accountCredits, setAccountCredits] = useState<string | null>(null);
  const [accountDetail, setAccountDetail] = useState<string | null>(null);
  const walletRefresh = useRef<(() => void) | null>(null);
  const [engineLive, setEngineLive] = useState(false);
  const [packs, setPacks] = useState<Array<{ id: string; credits: number; priceUsd: number }> | null>(null);
  const [checkoutEnabled, setCheckoutEnabled] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState<string | null>(null);
  const [checkoutNote, setCheckoutNote] = useState<string | null>(null);
  const [plansOpen, setPlansOpen] = useState(false);

  // The credits popover reads the public catalog once it is first opened.
  useEffect(() => {
    if (openMenu !== "credits" || packs) return;
    void fetch(apiUrl("/onboarding/plans")).then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (d?.packs) setPacks(d.packs);
    }).catch(() => undefined);
    void fetch(apiUrl("/onboarding/providers")).then((r) => (r.ok ? r.json() : null)).then((d) => {
      setCheckoutEnabled(Boolean(d?.checkout));
    }).catch(() => undefined);
  }, [openMenu, packs]);

  // One pack or plan purchase opens Stripe checkout in the browser.
  const buy = (body: Record<string, string>) => {
    const key = body.packId ?? body.planId ?? "";
    setCheckoutBusy(key);
    setCheckoutNote(null);
    void fetch(apiUrl("/billing/checkout"), { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(body) })
      .then((r) => r.json())
      .then((d) => {
        if (d?.url) {
          setCheckoutNote("Opening secure checkout…");
          void window.orvyn.window.openExternal?.(d.url);
        } else setCheckoutNote(String(d?.error ?? "Checkout isn't available yet."));
      })
      .catch(() => setCheckoutNote("Checkout isn't available right now."))
      .finally(() => setCheckoutBusy(null));
  };
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void fetch(healthUrl())
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (alive) setEngineLive(Boolean(body && (body.status === "ok" || body.status === "healthy" || body.ok === true)));
      })
      .catch(() => {
        if (alive) setEngineLive(false);
      });
    // The header shows the ACCOUNT's wallet (ledger), refreshed while the app
    // is open and after each run — never a single run's spend or budget.
    const loadWallet = () => void fetch(apiUrl("/billing"), { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!alive) return;
        if (!body?.wallet) { setAccountCredits(null); return; }
        const plan = typeof body.wallet.plan?.label === "string" ? body.wallet.plan.label : null;
        const cycle = body.wallet.windows?.cycle;
        const used = Number(cycle?.used);
        const limit = Number(cycle?.limit);
        const available = Number(body.wallet.availableBalance);
        const credits = Number.isFinite(available)
          ? `${Math.max(0, Math.round(available)).toLocaleString()} credits left`
          : Number.isFinite(used) && Number.isFinite(limit) && limit > 0
            ? `${Math.max(0, Math.round(limit - used)).toLocaleString()} credits left`
            : null;
        setAccountPlan(plan);
        setAccountCredits(credits);
        setAccountDetail(Number.isFinite(used) && Number.isFinite(limit) && limit > 0 ? `${Math.round(used).toLocaleString()} of ${Math.round(limit).toLocaleString()} used this cycle${plan ? ` · ${plan} plan` : ""}` : null);
      })
      .catch(() => undefined);
    loadWallet();
    const walletTimer = setInterval(loadWallet, 60_000);
    walletRefresh.current = loadWallet;
    return () => {
      alive = false;
      clearInterval(walletTimer);
    };
  }, []);
  // A run's spend changed (it ran or finished): the wallet moved too.
  useEffect(() => { walletRefresh.current?.(); }, [usageLabel]);

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
      onDoubleClick={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest(".no-drag")) return;
        void window.orvyn.window.toggleMaximize().then(setMaximized);
      }}
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
            Ask ORVYN to build, fix, deploy, research, or run a task...
          </span>
          <span
            className="orvyn-title-optional"
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

      <div style={{ display: "flex", alignItems: "center", gap: 8, paddingRight: 6 }} className="no-drag">
        <AccountCluster onOpenSettings={onOpenSettings} onSwitchWorkspace={onSwitchWorkspace} />
        {(accountPlan || planLabel) && (
          <span
            data-testid="title-plan"
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--orvyn-text-secondary)",
              whiteSpace: "nowrap",
            }}
          >
            {accountPlan || planLabel}
          </span>
        )}
        {accountCredits && (
          <span data-testid="title-credits-wrap" style={{ position: "relative", display: "inline-flex" }}>
            <button
              data-testid="title-credits"
              onClick={() => setOpenMenu(openMenu === "credits" ? null : "credits")}
              title={[accountDetail, usageLabel ? `This run: ${usageLabel}` : null, usageTitle, "Click to top up or change plan"].filter(Boolean).join("\n")}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11,
                color: "var(--orvyn-text-secondary)",
                background: openMenu === "credits" ? "var(--orvyn-surface-3, #131c2e)" : "var(--orvyn-surface-2)",
                border: "1px solid var(--orvyn-border-soft)",
                borderRadius: 999,
                padding: "3px 10px",
                whiteSpace: "nowrap",
                cursor: "pointer",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#7dd3fc" strokeWidth="1.7">
                <path d="M13 2 4 14h7l-1 8 9-12h-7z" strokeLinejoin="round" />
              </svg>
              {accountCredits}
              <span style={{ fontSize: 12, lineHeight: 1, color: "#7dd3fc", fontWeight: 700 }} aria-hidden>+</span>
            </button>
            {openMenu === "credits" && (
              <div
                data-testid="credits-popover"
                style={{
                  position: "absolute",
                  top: "calc(100% + 8px)",
                  right: 0,
                  zIndex: 60,
                  width: 250,
                  background: "var(--orvyn-surface-2)",
                  border: "1px solid var(--orvyn-border)",
                  borderRadius: 10,
                  boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
                  padding: 10,
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", padding: "2px 4px 6px" }}>
                  {accountDetail ?? "Credit balance"}
                </div>
                {(packs ?? []).map((p) => (
                  <button
                    key={p.id}
                    disabled={!checkoutEnabled || checkoutBusy !== null}
                    onClick={() => buy({ packId: p.id })}
                    style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      fontSize: 11.5, padding: "6px 8px", borderRadius: 7, cursor: "pointer",
                      background: "var(--orvyn-surface-3, #131c2e)", color: "var(--orvyn-text)",
                      border: "1px solid var(--orvyn-border-soft)",
                      opacity: checkoutEnabled ? 1 : 0.55,
                    }}
                  >
                    <span>{p.credits.toLocaleString("en-US")} credits</span>
                    <span style={{ fontWeight: 650 }}>${p.priceUsd}{checkoutBusy === p.id ? " …" : ""}</span>
                  </button>
                ))}
                {!packs && <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", padding: 4 }}>Loading packs…</div>}
                <button
                  onClick={() => { setOpenMenu(null); setPlansOpen(true); }}
                  style={{
                    marginTop: 4, fontSize: 11.5, fontWeight: 650, padding: "7px 8px", borderRadius: 7, cursor: "pointer",
                    background: "#2563eb", border: "1px solid #2563eb", color: "#f8fafc",
                  }}
                >
                  View plans & upgrade
                </button>
                {checkoutNote && <div style={{ fontSize: 10.5, color: "var(--orvyn-text-muted)", padding: "2px 4px" }}>{checkoutNote}</div>}
              </div>
            )}
          </span>
        )}
        {engineLive && (
          <span
            data-testid="title-live"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 11,
              fontWeight: 650,
              color: "#bbf7d0",
              background: "rgba(52,211,153,0.12)",
              border: "1px solid rgba(52,211,153,0.35)",
              borderRadius: 999,
              padding: "2px 8px",
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#34d399" }} />
            Live
          </span>
        )}
        <button
          className="orvyn-title-optional"
          title="Notifications"
          aria-label="Notifications"
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
        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          onClick={() => onOpenSettings?.()}
          style={{
            width: 28,
            height: 28,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: "none",
            borderRadius: 6,
            color: "var(--orvyn-text-secondary)",
            cursor: "pointer",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c.3.7.9 1.1 1.6 1.1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <div style={{ display: "flex", height: "100%" }} className="no-drag orvyn-window-controls">
        <WinButton onClick={() => window.orvyn.window.minimize()} label="Minimize">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" strokeWidth="1" /></svg>
        </WinButton>
        <WinButton onClick={() => window.orvyn.window.toggleMaximize().then(setMaximized)} label={maximized ? "Restore" : "Maximize"}>
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
      {plansOpen && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setPlansOpen(false); }}
          style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(4,7,15,0.82)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
        >
          <div style={{ maxWidth: 860, width: "100%", maxHeight: "86vh", overflowY: "auto", background: "var(--orvyn-surface-1)", border: "1px solid var(--orvyn-border)", borderRadius: 14, padding: 20, position: "relative" }} className="no-drag">
            <button
              onClick={() => setPlansOpen(false)}
              style={{ position: "absolute", top: 10, right: 10, fontSize: 12, cursor: "pointer", background: "var(--orvyn-surface-2)", border: "1px solid var(--orvyn-border-soft)", borderRadius: 7, padding: "4px 10px", color: "var(--orvyn-text)" }}
            >
              Close
            </button>
            <PlansPanel currentId="free" checkout={checkoutEnabled} onBack={() => setPlansOpen(false)} />
          </div>
        </div>
      )}
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
