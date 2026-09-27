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
  return headerIconBtn(active, "cyan");
}

/** 28px header control. Follow ORION uses the violet accent; selection uses cyan. */
export function headerIconBtn(active = false, accent: "cyan" | "violet" = "cyan"): React.CSSProperties {
  const background = !active
    ? "transparent"
    : accent === "violet"
      ? "rgba(124,92,255,0.22)"
      : "rgba(34,211,238,0.12)";
  const color = !active ? "var(--orvyn-text-muted)" : accent === "violet" ? "#c4b5fd" : "var(--orvyn-cyan)";
  return {
    background,
    border: "none",
    color,
    width: 28,
    height: 28,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    borderRadius: 6,
    flexShrink: 0,
    padding: 0,
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

/** Flat IDE tab. Active state is brighter text, not a pill or heavy underline. */
export function tabBtn(active: boolean): React.CSSProperties {
  return {
    background: "transparent",
    border: "none",
    boxShadow: "none",
    borderRadius: 0,
    color: active ? "#f4f7fb" : "#8b95a8",
    fontSize: 13,
    fontWeight: active ? 500 : 450,
    padding: "0 10px",
    height: 36,
    minWidth: 0,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    flex: "0 0 auto",
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
