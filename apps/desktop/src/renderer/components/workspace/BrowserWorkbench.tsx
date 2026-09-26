import React, { useEffect, useRef, useState } from "react";
import type { WorkbenchBrowserRecent, WorkbenchBrowserState, WorkbenchBrowserTab } from "../../orvyn-bridge";
import { IconExternal, IconGlobe, IconMore, IconRefresh } from "../Icons";
import { emptyBody, emptyTitle, ghostBtn } from "./workspaceChrome";

export function BrowserWorkbench({
  kind,
  projectName,
  orionStatus,
  requestedUrl,
  sessionId,
  surfaceActive = true,
  onTabs,
  addressFocusToken,
  liveVersion = 0,
  updating = false,
}: {
  kind: "browser" | "preview";
  projectName?: string | null;
  orionStatus?: string | null;
  requestedUrl?: string;
  sessionId?: string;
  surfaceActive?: boolean;
  onTabs: (state: WorkbenchBrowserState) => void;
  addressFocusToken?: number;
  liveVersion?: number;
  updating?: boolean;
}) {
  const api = window.orvyn.browser;
  const [state, setState] = useState<WorkbenchBrowserState>({ tabs: [], recents: [], activeId: null });
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState(false);
  const [deviceMenu, setDeviceMenu] = useState(false);
  const [device, setDevice] = useState<"desktop" | "tablet" | "mobile">("desktop");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [stopped, setStopped] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const seenVersion = useRef(0);
  const surface = useRef<HTMLDivElement | null>(null);
  const address = useRef<HTMLInputElement | null>(null);
  const hasNative = Boolean(api) && /Electron/i.test(navigator.userAgent);

  useEffect(() => {
    if (!api) return;
    void api.list().then(apply);
    return api.onChange((next) => apply(next));
  }, []);

  useEffect(() => {
    if (addressFocusToken) address.current?.focus();
  }, [addressFocusToken]);

  useEffect(() => {
    if (!api || !sessionId) return;
    if (state.activeId !== sessionId) void api.activate(sessionId).then(apply);
  }, [sessionId]);

  useEffect(() => {
    if (requestedUrl && hasNative) {
      const existing = state.tabs.find((t) => t.url === requestedUrl);
      if (!existing && !sessionId) void api!.create(kind, requestedUrl).then(apply);
    }
  }, [requestedUrl, kind, sessionId]);

  const tabForBounds = activeTab(state);
  const surfaceShown = Boolean(tabForBounds?.url && !tabForBounds.error);

  useEffect(() => {
    const node = surface.current;
    if (!node || !api || !surfaceShown) return;
    const send = () => {
      const r = node.getBoundingClientRect();
      void api.setBounds({ x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
    };
    const ro = new ResizeObserver(send);
    ro.observe(node);
    window.addEventListener("resize", send);
    send();
    const again = window.setTimeout(send, 50);
    return () => {
      window.clearTimeout(again);
      ro.disconnect();
      window.removeEventListener("resize", send);
    };
  }, [api, surfaceShown, state.activeId, tabForBounds?.url, expanded, fullscreen]);

  useEffect(() => {
    const tab = activeTab(state);
    const show = Boolean(surfaceActive && hasNative && tab?.url && !tab.error && !menu);
    void api?.setVisible(show);
    if (show && tab?.id && state.activeId !== tab.id) void api?.activate(tab.id);
  }, [state.activeId, tabForBounds?.url, tabForBounds?.error, hasNative, surfaceActive, menu]);

  useEffect(() => {
    return () => {
      void api?.setVisible(false);
    };
  }, [api]);

  useEffect(() => {
    if (kind !== "preview" || !autoRefresh || liveVersion <= 0) return;
    const previous = seenVersion.current;
    seenVersion.current = liveVersion;
    if (previous === 0 || previous === liveVersion || stopped) return;
    const id = state.activeId;
    if (id) void api?.reload(id).then(apply);
  }, [liveVersion, autoRefresh, kind, stopped]);

  useEffect(() => {
    if (!expanded && !fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (fullscreen) setFullscreen(false);
      else setExpanded(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [expanded, fullscreen]);

  function apply(next: WorkbenchBrowserState) {
    setState(next);
    onTabs(next);
    const tab = activeTab(next);
    if (tab?.url) setDraft(tab.url);
  }

  const tab = activeTab(state);
  const start = !tab?.url;

  async function go(raw: string) {
    if (!api || !hasNative) return;
    const current = tab ?? (await api.create(kind)).tabs.slice(-1)[0];
    if (!current) return;
    apply(await api.navigate(current.id, raw));
  }

  const frameStyle = expanded || fullscreen
    ? {
        position: "fixed" as const,
        inset: 0,
        zIndex: 1000,
        background: "#070b14",
        display: "flex",
        flexDirection: "column" as const,
        minHeight: 0,
      }
    : { flex: 1, minHeight: 0, display: "flex" as const, flexDirection: "column" as const };

  return (
    <div style={frameStyle} data-testid="workbench-browser" data-expanded={expanded ? "true" : "false"} data-fullscreen={fullscreen ? "true" : "false"}>
      {!fullscreen && (
      <div data-testid="preview-controls" style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderBottom: "1px solid var(--orvyn-border-soft)", flexShrink: 0 }}>
        <button title="Back" aria-label="Back" disabled={!tab?.canGoBack} style={ghostBtn()} onClick={() => tab && void api?.back(tab.id).then(apply)}>←</button>
        <button title="Forward" aria-label="Forward" disabled={!tab?.canGoForward} style={ghostBtn()} onClick={() => tab && void api?.forward(tab.id).then(apply)}>→</button>
        <button title={tab?.loading ? "Stop" : "Refresh"} aria-label="Refresh" style={ghostBtn()} onClick={() => tab && void api?.reload(tab.id).then(apply)}>
          {tab?.loading ? "■" : <IconRefresh size={12} />}
        </button>
        <form
          style={{ flex: 1, minWidth: 0 }}
          onSubmit={(e) => {
            e.preventDefault();
            void go(draft);
          }}
        >
          <input
            ref={address}
            data-testid="workbench-address"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search or enter URL"
            style={{
              width: "100%",
              background: "var(--orvyn-surface-2)",
              border: "1px solid var(--orvyn-border-soft)",
              borderRadius: 6,
              color: "var(--orvyn-text)",
              fontSize: 12,
              padding: "5px 8px",
              fontFamily: "var(--font-mono)",
            }}
          />
        </form>
        <button title="Open in new tab" aria-label="Open in new tab" style={ghostBtn()} disabled={!tab?.url} onClick={() => tab && void api?.openExternal(tab.id)}>
          <IconExternal size={12} />
        </button>
        <div style={{ position: "relative" }}>
          <button title="Responsive preview" aria-label="Responsive preview" style={ghostBtn()} onClick={() => { setDeviceMenu((v) => !v); setMenu(false); }}>
            {device === "mobile" ? "Mobile" : device === "tablet" ? "Tablet" : "Desktop"}
          </button>
          {deviceMenu && (
            <div style={{ position: "absolute", right: 0, top: 28, zIndex: 30, minWidth: 140, background: "var(--orvyn-surface-2)", border: "1px solid var(--orvyn-border)", borderRadius: 8, padding: 4 }}>
              {(["desktop", "tablet", "mobile"] as const).map((id) => (
                <MenuItem key={id} label={id[0].toUpperCase() + id.slice(1)} onClick={() => { setDevice(id); setDeviceMenu(false); }} />
              ))}
            </div>
          )}
        </div>
        <div style={{ position: "relative" }}>
          <button title="More" aria-label="More" style={ghostBtn()} onClick={() => { setMenu((v) => !v); setDeviceMenu(false); }}><IconMore size={12} /></button>
          {menu && (
            <div style={{ position: "absolute", right: 0, top: 28, zIndex: 30, minWidth: 180, background: "var(--orvyn-surface-2)", border: "1px solid var(--orvyn-border)", borderRadius: 8, padding: 4 }}>
              <MenuItem label={expanded ? "Collapse" : "Expand"} onClick={() => { setFullscreen(false); setExpanded((v) => !v); setMenu(false); }} />
              <MenuItem label="Full screen" onClick={() => { setExpanded(true); setFullscreen(true); setMenu(false); }} />
              {tab?.controlOwner === "orion" && <MenuItem label="Take control" onClick={() => { void api?.takeControl(tab.id).then(apply); setMenu(false); }} />}
              {tab?.controlOwner === "user" && <MenuItem label="Return to ORION" onClick={() => { void api?.returnControl(tab.id).then(apply); setMenu(false); }} />}
              <MenuItem label="Clear browsing data" onClick={() => { void api?.clearData().then(apply); setMenu(false); }} />
              <MenuItem label="Inspect page" onClick={() => { if (tab) void api?.openDevTools(tab.id); setMenu(false); }} />
            </div>
          )}
        </div>
      </div>
      )}
      {!fullscreen && tab?.download && (
        <div style={{ padding: "4px 10px", fontSize: 11, color: "var(--orvyn-text-muted)" }}>
          Download {tab.download.filename} · {tab.download.state}
        </div>
      )}

      {start ? (
        <StartPage recents={state.recents} onGo={(u) => void go(u)} native={hasNative} draft={draft} setDraft={setDraft} />
      ) : tab?.error ? (
        <ErrorPage tab={tab} local={kind === "preview"} onRetry={() => void go(tab.url)} />
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: "flex", justifyContent: "center", background: "#070b14" }}>
        <div ref={surface} data-testid="workbench-browser-surface" className="orvyn-browser-surface" style={{ flex: device === "desktop" ? 1 : undefined, width: device === "mobile" ? 390 : device === "tablet" ? 768 : "100%", maxWidth: "100%", minHeight: 0, background: "#0b0e14", color: "var(--orvyn-text-muted)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          {!hasNative ? (
            <div style={{ padding: 28, textAlign: "center" }}>
              <div style={emptyTitle()}>Embedded browser requires ORVYN Desktop</div>
              <div style={emptyBody()}>The packaged app opens real websites in a sandboxed WebContentsView. Vite preview cannot host native web contents.</div>
            </div>
          ) : (
            <div style={{ fontSize: 12 }}>{tab?.loading ? `Opening ${tab.url}` : "Page opens in this pane."}</div>
          )}
        </div>
        </div>
      )}
      {fullscreen && (
        <button
          data-testid="preview-exit-fullscreen"
          onClick={() => setFullscreen(false)}
          style={{ position: "absolute", top: 10, right: 10, zIndex: 7, ...ghostBtn(), background: "rgba(11,18,32,0.85)" }}
        >
          Exit Full Screen (Esc)
        </button>
      )}
      {kind === "preview" && !fullscreen && (
        <div
          data-testid="preview-footer"
          style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", borderTop: "1px solid var(--orvyn-border-soft)", fontSize: 11, color: "var(--orvyn-text-secondary)", flexShrink: 0 }}
        >
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: tab?.url && !stopped ? "#34d399" : "#64748b", flexShrink: 0 }} />
          <span>{tab?.url && !stopped ? `Live Preview (v${Math.max(liveVersion, 1)})` : stopped ? "Preview stopped" : "Preview"}</span>
          {updating && autoRefresh && !stopped && <span style={{ color: "var(--orvyn-text-muted)" }}>Updating after file changes</span>}
          <label style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            Auto Refresh
          </label>
          <button style={ghostBtn()} disabled={!tab?.url} onClick={() => tab && void api?.openExternal(tab.id)}>Open in new tab</button>
          <button
            style={ghostBtn()}
            onClick={() => {
              setStopped(true);
              if (tab) void api?.close(tab.id).then(apply);
            }}
          >
            Stop Preview
          </button>
        </div>
      )}
    </div>
  );
}

function StartPage({
  recents,
  onGo,
  native,
  draft,
  setDraft,
}: {
  recents: WorkbenchBrowserRecent[];
  onGo: (url: string) => void;
  native: boolean;
  draft: string;
  setDraft: (v: string) => void;
}) {
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "48px 28px 28px" }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onGo(draft);
        }}
        style={{ maxWidth: 560, margin: "0 auto 36px" }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Search or enter URL..."
          style={{
            width: "100%",
            background: "var(--orvyn-surface-2)",
            border: "1px solid var(--orvyn-border)",
            borderRadius: 12,
            color: "var(--orvyn-text)",
            fontSize: 16,
            padding: "14px 16px",
          }}
        />
      </form>
      {!native && (
        <div style={{ ...emptyBody(), margin: "0 auto 24px", textAlign: "center" }}>
          Open the packaged ORVYN app to browse real websites inside the Workbench.
        </div>
      )}
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", marginBottom: 10 }}>Recents</div>
        {recents.length === 0 ? (
          <div style={emptyBody()}>Visited pages and local previews will appear here.</div>
        ) : (
          recents.map((r) => (
            <button
              key={r.url}
              onClick={() => onGo(r.url)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                textAlign: "left",
                background: "transparent",
                border: "none",
                color: "var(--orvyn-text)",
                padding: "10px 0",
                cursor: "pointer",
              }}
            >
              {r.favicon ? <img src={r.favicon} alt="" width={14} height={14} /> : <IconGlobe size={14} />}
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title || r.url}</span>
                <span style={{ fontSize: 11, color: "var(--orvyn-text-muted)", fontFamily: "var(--font-mono)" }}>{r.url.replace(/^https?:\/\//, "")}</span>
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function ErrorPage({ tab, local, onRetry }: { tab: WorkbenchBrowserTab; local: boolean; onRetry: () => void }) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 28, textAlign: "center" }}>
      <div style={emptyTitle()}>{local ? "Preview unavailable" : "Unable to load page"}</div>
      <div style={emptyBody()}>{local ? "The local server is no longer responding." : tab.error?.description}</div>
      <code style={{ fontSize: 12 }}>{tab.url}</code>
      {tab.error?.code && <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)" }}>{tab.error.code}</div>}
      <button style={ghostBtn()} onClick={onRetry}>Retry</button>
    </div>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ display: "block", width: "100%", background: "transparent", border: "none", color: "var(--orvyn-text-secondary)", textAlign: "left", fontSize: 12, padding: "6px 8px", cursor: "pointer" }}>
      {label}
    </button>
  );
}

function activeTab(state: WorkbenchBrowserState): WorkbenchBrowserTab | undefined {
  return state.tabs.find((t) => t.id === state.activeId) ?? state.tabs[0];
}

