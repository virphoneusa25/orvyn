import React, { useEffect, useRef, useState } from "react";
import type { AgentWorkspaceDerived } from "../../agentWorkspaceModel";
import { isSafeHttpUrl } from "../../agentWorkspaceModel";
import { IconExternal, IconRefresh } from "../Icons";
import { OrionCursorOverlay } from "./OrionCursorOverlay";
import { emptyBody, emptyTitle, ghostBtn } from "./workspaceChrome";

export function BrowserView({
  browser,
  status,
  recents,
  url,
  onNavigate,
}: {
  browser: AgentWorkspaceDerived["browser"];
  status?: string | null;
  recents: string[];
  url?: string;
  onNavigate: (url: string) => void;
}) {
  const [draft, setDraft] = useState(url ?? browser.url ?? "");
  const [drawer, setDrawer] = useState<"none" | "console" | "network">("none");
  const [frameKey, setFrameKey] = useState(0);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const current = url || browser.url || "";
  const latestShot = [...browser.actions].reverse().find((a) => a.snapshot)?.snapshot;
  const live = browser.actions.some((a) => a.live);
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(current);

  useEffect(() => {
    if (url) setDraft(url);
  }, [url]);

  function go(next: string) {
    const raw = next.trim();
    if (!raw) return;
    const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    if (!isSafeHttpUrl(href)) return;
    onNavigate(href);
    setDraft(href);
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderBottom: "1px solid var(--orvyn-border-soft)" }}>
        <button title="Back" style={ghostBtn()} onClick={() => frameRef.current?.contentWindow?.history.back()}>←</button>
        <button title="Forward" style={ghostBtn()} onClick={() => frameRef.current?.contentWindow?.history.forward()}>→</button>
        <button title="Reload" style={ghostBtn()} onClick={() => { if (!current) return; setFrameKey((n) => n + 1); }}><IconRefresh size={12} /></button>
        <form
          style={{ flex: 1, minWidth: 0 }}
          onSubmit={(e) => {
            e.preventDefault();
            go(draft);
          }}
        >
          <input
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
            }}
          />
        </form>
        {current && (
          <button style={ghostBtn()} onClick={() => void window.orvyn.window.openExternal?.(current)}>
            <IconExternal size={12} />
          </button>
        )}
        <button style={ghostBtn()} onClick={() => setDrawer(drawer === "console" ? "none" : "console")}>Console</button>
        <button style={ghostBtn()} onClick={() => setDrawer(drawer === "network" ? "none" : "network")}>Network</button>
      </div>

      {!current && browser.actions.length === 0 ? (
        <div style={{ flex: 1, overflowY: "auto", padding: 28 }}>
          <div style={emptyTitle()}>Browser</div>
          <div style={{ ...emptyBody(), margin: "8px 0 18px" }}>External docs, GitHub, and research. Local apps ORION is building open as Preview tabs instead.</div>
          {recents.length > 0 && (
            <div>
              <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", marginBottom: 8 }}>Recents</div>
              {recents.map((u) => (
                <button
                  key={u}
                  onClick={() => go(u)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    color: "var(--orvyn-text-secondary)",
                    padding: "8px 0",
                    cursor: "pointer",
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                  }}
                >
                  {u}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, position: "relative", background: "#0b1020" }}>
          {local && current ? (
            <iframe
              key={`${current}:${frameKey}`}
              ref={frameRef}
              title="Browser"
              src={current}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              style={{ width: "100%", height: "100%", border: "none", background: "#fff" }}
            />
          ) : latestShot ? (
            <img src={latestShot} alt="Browser evidence" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
          ) : (
            <div style={{ padding: 20 }}>
              <div style={{ fontSize: 11, color: live ? "var(--orvyn-green)" : "var(--orvyn-text-muted)" }}>{live ? "Live" : "Session"}</div>
              <code style={{ fontSize: 12 }}>{current || "—"}</code>
              <div style={{ marginTop: 12 }}>
                {browser.actions.slice(-10).reverse().map((a) => (
                  <div key={a.id} style={{ fontSize: 12, padding: "6px 0", color: "var(--orvyn-text-secondary)" }}>{a.kind} · {a.label}</div>
                ))}
              </div>
            </div>
          )}
          <OrionCursorOverlay cursor={browser.cursor} status={status} />
        </div>
      )}

      {drawer !== "none" && (
        <div style={{ height: 140, borderTop: "1px solid var(--orvyn-border-soft)", overflow: "auto", padding: 8, fontFamily: "var(--font-mono)", fontSize: 11 }}>
          {drawer === "console" && (browser.console.length === 0 ? <div style={{ color: "var(--orvyn-text-muted)" }}>No captured console errors.</div> : browser.console.map((l, i) => <div key={i}>{l}</div>))}
          {drawer === "network" && (browser.network.length === 0 ? <div style={{ color: "var(--orvyn-text-muted)" }}>No failed requests captured.</div> : browser.network.map((n, i) => (
            <div key={i}><span style={{ color: "var(--orvyn-red)" }}>{n.status ?? "ERR"}</span> {n.method} {n.url}</div>
          )))}
        </div>
      )}
    </div>
  );
}
