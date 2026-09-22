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
}: {
  kind: "browser" | "preview";
  projectName?: string | null;
  orionStatus?: string | null;
  requestedUrl?: string;
  sessionId?: string;
  surfaceActive?: boolean;
  onTabs: (state: WorkbenchBrowserState) => void;
  addressFocusToken?: number;
}) {
  const api = window.orvyn.browser;
  const [state, setState] = useState<WorkbenchBrowserState>({ tabs: [], recents: [], activeId: null });
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState(false);
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

  useEffect(() => {
    const node = surface.current;
    if (!node || !api) return;
    const send = () => {
      const r = node.getBoundingClientRect();
      void api.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
    };
    const ro = new ResizeObserver(send);
    ro.observe(node);
    window.addEventListener("resize", send);
    send();
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", send);
    };
  }, [state.activeId, state.tabs.length]);

  useEffect(() => {
    const tab = activeTab(state);
    const show = Boolean(surfaceActive && hasNative && tab?.url && !tab.error);
    void api?.setVisible(show);
    if (surfaceActive && tab?.id) void api?.activate(tab.id);
    if (!surfaceActive) void api?.setVisible(false);
    return () => {
      void api?.setVisible(false);
    };
  }, [state.activeId, state.tabs, hasNative, surfaceActive]);

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

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }} data-testid="workbench-browser">
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderBottom: "1px solid var(--orvyn-border-soft)", flexShrink: 0 }}>
        <button title="Back" disabled={!tab?.canGoBack} style={ghostBtn()} onClick={() => tab && void api?.back(tab.id).then(apply)}>←</button>
        <button title="Forward" disabled={!tab?.canGoForward} style={ghostBtn()} onClick={() => tab && void api?.forward(tab.id).then(apply)}>→</button>
        <button title={tab?.loading ? "Stop" : "Reload"} style={ghostBtn()} onClick={() => tab && void api?.reload(tab.id).then(apply)}>
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
        {tab?.url && (
          <button title="Open externally" style={ghostBtn()} onClick={() => void api?.openExternal(tab.id)}>
            <IconExternal size={12} />
          </button>
        )}
        {tab?.controlOwner === "orion" && (
          <button style={ghostBtn()} onClick={() => tab && void api?.takeControl(tab.id).then(apply)}>Take Control</button>
        )}
        {tab?.controlOwner === "user" && orionStatus && (
          <button style={ghostBtn()} onClick={() => tab && void api?.returnControl(tab.id).then(apply)}>Return to ORION</button>
        )}
        <div style={{ position: "relative" }}>
          <button title="More" style={ghostBtn()} onClick={() => setMenu((v) => !v)}><IconMore size={12} /></button>
          {menu && (
            <div style={{ position: "absolute", right: 0, top: 28, zIndex: 30, minWidth: 180, background: "var(--orvyn-surface-2)", border: "1px solid var(--orvyn-border)", borderRadius: 8, padding: 4 }}>
              <MenuItem label="Clear browsing data" onClick={() => { void api?.clearData().then(apply); setMenu(false); }} />
              <MenuItem label="Inspect page" onClick={() => { if (tab) void api?.openDevTools(tab.id); setMenu(false); }} />
            </div>
          )}
        </div>
      </div>

      {orionStatus && tab?.controlOwner === "orion" && (
        <div style={{ padding: "4px 10px", fontSize: 11, color: "var(--orvyn-cyan)", borderBottom: "1px solid var(--orvyn-border-soft)" }}>{orionStatus}</div>
      )}
      {tab?.controlOwner === "user" && orionStatus && (
        <div style={{ padding: "4px 10px", fontSize: 11, color: "var(--orvyn-yellow)", borderBottom: "1px solid var(--orvyn-border-soft)" }}>You are controlling this browser</div>
      )}
      {tab?.download && (
        <div style={{ padding: "4px 10px", fontSize: 11, color: "var(--orvyn-text-muted)" }}>
          Download {tab.download.filename} · {tab.download.state}
        </div>
      )}

      {start ? (
        <StartPage recents={state.recents} onGo={(u) => void go(u)} native={hasNative} draft={draft} setDraft={setDraft} />
      ) : tab?.error ? (
        <ErrorPage tab={tab} local={kind === "preview"} onRetry={() => void go(tab.url)} />
      ) : (
        <div ref={surface} data-testid="workbench-browser-surface" className="orvyn-browser-surface" style={{ flex: 1, minHeight: 0, background: "transparent" }}>
          {!hasNative && (
            <div style={{ padding: 28, textAlign: "center" }}>
              <div style={emptyTitle()}>Embedded browser requires ORVYN Desktop</div>
              <div style={emptyBody()}>The packaged app opens real websites in a sandboxed WebContentsView. Vite preview cannot host native web contents.</div>
            </div>
          )}
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

