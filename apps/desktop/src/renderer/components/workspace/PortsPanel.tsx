import React from "react";
import type { PublicPort } from "./useWorkbenchPorts";
import { IconClose, IconGlobe } from "../Icons";
import { emptyBody, emptyTitle, ghostBtn } from "./workspaceChrome";

export function PortsPanel({
  ports,
  autoForward,
  environment,
  onAutoForward,
  onOpen,
  onStop,
  onClose,
}: {
  ports: PublicPort[];
  autoForward: boolean;
  environment: string;
  onAutoForward: (next: boolean) => void;
  onOpen: (port: PublicPort) => void;
  onStop: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div
      data-testid="workbench-ports"
      style={{
        position: "absolute",
        top: 36,
        right: 8,
        zIndex: 30,
        width: 320,
        maxHeight: "70%",
        overflow: "auto",
        background: "var(--orvyn-surface-2)",
        border: "1px solid var(--orvyn-border)",
        borderRadius: 10,
        boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
        padding: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 650, flex: 1 }}>Ports</div>
        <span style={{ fontSize: 10, color: "var(--orvyn-text-muted)" }}>{environment}</span>
        <button title="Close ports" style={ghostBtn()} onClick={onClose}><IconClose size={11} /></button>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginBottom: 10, color: "var(--orvyn-text-secondary)" }}>
        <input type="checkbox" checked={autoForward} onChange={(e) => onAutoForward(e.target.checked)} />
        Auto-Forward Ports
      </label>
      <div style={{ fontSize: 10, letterSpacing: 0.7, color: "var(--orvyn-text-muted)", marginBottom: 6 }}>FORWARDED</div>
      {ports.length === 0 ? (
        <div style={{ padding: "16px 6px" }}>
          <div style={emptyTitle()}>No services yet</div>
          <div style={emptyBody()}>When a web server starts in this environment, safe preview ports appear here. Databases and control-plane ports stay hidden.</div>
        </div>
      ) : (
        ports.map((p) => (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 4px", borderBottom: "1px solid var(--orvyn-border-soft)" }}>
            <span
              title={p.status}
              style={{
                width: 7,
                height: 7,
                borderRadius: 99,
                background: p.status === "forwarded" ? "var(--orvyn-green)" : p.status === "inactive" ? "var(--orvyn-text-muted)" : "var(--orvyn-cyan)",
              }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontFamily: "var(--font-mono)" }}>{p.port}</div>
              <div style={{ fontSize: 10, color: "var(--orvyn-text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {p.command || p.classification} · {p.environment}
              </div>
            </div>
            <button title="Open in Browser" style={ghostBtn()} onClick={() => onOpen(p)}><IconGlobe size={12} /></button>
            <button title="Stop forwarding" style={ghostBtn()} onClick={() => onStop(p.id)}>×</button>
          </div>
        ))
      )}
    </div>
  );
}
