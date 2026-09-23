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
    <div style={{ padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 650 }}>Port Forwarding</div>
          <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)", marginTop: 2 }}>Access your services locally</div>
        </div>
        <span style={{ fontSize: 10, color: "var(--orvyn-text-muted)" }}>{environment}</span>
        <button title="Close ports" style={ghostBtn()} onClick={onClose}><IconClose size={11} /></button>
      </div>
      <div style={{ fontSize: 10, letterSpacing: 0.7, color: "var(--orvyn-text-muted)", margin: "12px 0 6px" }}>FORWARDED / DETECTED</div>
      {ports.length === 0 ? (
        <div style={{ padding: "16px 6px" }}>
          <div style={emptyTitle()}>No services yet</div>
          <div style={emptyBody()}>When a web server starts in this environment, safe preview ports appear here. Databases and control-plane ports stay hidden.</div>
        </div>
      ) : (
        ports.map((p) => (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 4px", borderBottom: "1px solid var(--orvyn-border-soft)" }}>
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
              <div style={{ fontSize: 12, fontFamily: "var(--font-mono)" }}>
                {p.port} <span style={{ color: "var(--orvyn-text-muted)", fontFamily: "var(--font-ui)" }}>{p.command || p.classification}</span>
              </div>
              <div style={{ fontSize: 10, color: "var(--orvyn-text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {p.previewUrl || p.localUrl || p.environment}
              </div>
            </div>
            <button title="Open in Browser" style={ghostBtn()} onClick={() => onOpen(p)}><IconGlobe size={12} /></button>
            <button title="Stop forwarding" style={ghostBtn()} onClick={() => onStop(p.id)}>×</button>
          </div>
        ))
      )}
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginTop: 12, color: "var(--orvyn-text-secondary)" }}>
        <input type="checkbox" checked={autoForward} onChange={(e) => onAutoForward(e.target.checked)} />
        Auto-Forward Ports
      </label>
    </div>
  );
}
