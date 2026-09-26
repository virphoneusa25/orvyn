import type React from "react";

export function emptyPane(title: string, body: string): React.CSSProperties {
  return {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: 28,
    textAlign: "center",
    gap: 8,
  };
}

export function emptyTitle(): React.CSSProperties {
  return { fontSize: 13, fontWeight: 600, color: "var(--orvyn-text-secondary)" };
}

export function emptyBody(): React.CSSProperties {
  return { fontSize: 12, lineHeight: 1.6, color: "var(--orvyn-text-muted)", maxWidth: 320 };
}

export function iconBtn(active = false): React.CSSProperties {
  return {
    background: active ? "rgba(108,92,255,0.16)" : "transparent",
    border: "none",
    color: active ? "var(--orvyn-cyan)" : "var(--orvyn-text-muted)",
    width: 26,
    height: 26,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    borderRadius: 6,
  };
}

export function ghostBtn(): React.CSSProperties {
  return {
    background: "transparent",
    border: "1px solid var(--orvyn-border-soft)",
    borderRadius: 6,
    color: "var(--orvyn-text-secondary)",
    fontSize: 11,
    padding: "3px 9px",
    cursor: "pointer",
  };
}

export function tabBtn(active: boolean): React.CSSProperties {
  return {
    background: active ? "linear-gradient(180deg, rgba(124,92,255,0.28), rgba(34,211,238,0.1))" : "transparent",
    border: "none",
    borderBottom: active ? "2px solid #7dd3fc" : "2px solid transparent",
    boxShadow: active ? "inset 0 1px 0 rgba(196,181,253,0.45)" : "none",
    borderRadius: active ? "7px 7px 0 0" : 0,
    color: active ? "var(--orvyn-text)" : "var(--orvyn-text-muted)",
    fontSize: 11.5,
    fontWeight: active ? 650 : 500,
    padding: "0 10px",
    height: "100%",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    whiteSpace: "nowrap",
  };
}

export function splitHandle(active: boolean): React.CSSProperties {
  return {
    width: 6,
    cursor: "col-resize",
    flexShrink: 0,
    background: active ? "rgba(34,211,238,0.45)" : "transparent",
    transition: active ? "none" : "background 120ms ease",
  };
}

export async function openExternalSafe(url: string): Promise<boolean> {
  try {
    if (window.orvyn.window.openExternal) return await window.orvyn.window.openExternal(url);
    window.open(url, "_blank", "noopener,noreferrer");
    return true;
  } catch {
    return false;
  }
}
