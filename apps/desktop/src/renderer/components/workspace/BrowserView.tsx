import React, { useState } from "react";
import type { AgentWorkspaceDerived } from "../../agentWorkspaceModel";
import { IconExternal } from "../Icons";
import { OrionCursorOverlay } from "./OrionCursorOverlay";
import { emptyBody, emptyTitle, ghostBtn, openExternalSafe } from "./workspaceChrome";

export function BrowserView({
  browser,
  status,
}: {
  browser: AgentWorkspaceDerived["browser"];
  status?: string | null;
}) {
  const [drawer, setDrawer] = useState<"none" | "console" | "network">("none");
  const latestShot = [...browser.actions].reverse().find((a) => a.snapshot)?.snapshot;
  const live = browser.actions.some((a) => a.live);

  if (!browser.url && browser.actions.length === 0) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 28, textAlign: "center", gap: 8 }}>
        <div style={emptyTitle()}>No browser session</div>
        <div style={emptyBody()}>Browser activity will appear when ORION needs the web.</div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderBottom: "1px solid var(--orvyn-border-soft)", flexShrink: 0 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: live ? "var(--orvyn-green)" : "var(--orvyn-text-muted)" }}>{live ? "Live" : "Snapshot"}</span>
        <code style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", fontSize: 11, color: "var(--orvyn-text-secondary)" }}>{browser.url ?? "—"}</code>
        {browser.url && (
          <button style={ghostBtn()} onClick={() => void openExternalSafe(browser.url!)}>
            <IconExternal size={12} /> Open externally
          </button>
        )}
        <button style={ghostBtn()} onClick={() => setDrawer(drawer === "console" ? "none" : "console")}>Console</button>
        <button style={ghostBtn()} onClick={() => setDrawer(drawer === "network" ? "none" : "network")}>Network</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative", overflow: "auto", padding: 12 }}>
        {latestShot ? (
          <img src={latestShot} alt="Browser evidence" style={{ width: "100%", borderRadius: 8, border: "1px solid var(--orvyn-border-soft)" }} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {browser.actions.slice(-12).reverse().map((a) => (
              <div key={a.id} style={{ display: "flex", gap: 8, fontSize: 12, padding: "6px 8px", border: "1px solid var(--orvyn-border-soft)", borderRadius: 6 }}>
                <span style={{ color: "var(--orvyn-cyan)", width: 56, flexShrink: 0 }}>{a.kind}</span>
                <span style={{ color: "var(--orvyn-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.label}</span>
              </div>
            ))}
          </div>
        )}
        <OrionCursorOverlay cursor={browser.cursor} status={status} />
      </div>
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
