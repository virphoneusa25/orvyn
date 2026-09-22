import React from "react";
import { emptyBody, emptyTitle } from "./workspaceChrome";

export function DesktopView({ snapshot }: { snapshot?: string | null }) {
  if (!snapshot) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 28, textAlign: "center", gap: 8 }}>
        <div style={emptyTitle()}>No desktop session active</div>
        <div style={emptyBody()}>Desktop or computer-use evidence will appear here when ORION interacts with the local app window.</div>
      </div>
    );
  }
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "6px 10px", fontSize: 10, color: "var(--orvyn-text-muted)", borderBottom: "1px solid var(--orvyn-border-soft)" }}>Snapshot</div>
      <div style={{ flex: 1, overflow: "auto", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
        <img src={snapshot} alt="Desktop session" style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 8, border: "1px solid var(--orvyn-border-soft)" }} />
      </div>
    </div>
  );
}
