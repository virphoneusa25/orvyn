import React, { useEffect, useRef, useState } from "react";
import { isLocalPreviewUrl, isSafeHttpUrl, type BrowserAction, type PreviewTarget } from "../../agentWorkspaceModel";
import { IconExpand, IconExternal, IconRefresh } from "../Icons";
import { OrionCursorOverlay } from "./OrionCursorOverlay";
import { emptyBody, emptyTitle, ghostBtn, openExternalSafe } from "./workspaceChrome";

export function PreviewView({
  target,
  cursor,
  status,
  live,
  snapshot,
  onExpand,
  onClose,
}: {
  target?: PreviewTarget | null;
  cursor?: { x: number; y: number; kind: BrowserAction["kind"] } | null;
  status?: string | null;
  live?: boolean;
  snapshot?: string | null;
  onExpand?: () => void;
  onClose?: () => void;
}) {
  const [url, setUrl] = useState(target?.url ?? "");
  const [frameKey, setFrameKey] = useState(0);
  const [failed, setFailed] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    setUrl(target?.url ?? "");
    setFailed(false);
  }, [target?.url]);

  if (!target) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 28, textAlign: "center", gap: 8 }}>
        <div style={emptyTitle()}>No preview yet</div>
        <div style={emptyBody()}>When ORION starts a local web app, it will appear here.</div>
      </div>
    );
  }

  const local = target.local && isLocalPreviewUrl(target.url);
  const safe = isSafeHttpUrl(url || target.url);

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--orvyn-bg)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderBottom: "1px solid var(--orvyn-border-soft)", flexShrink: 0 }}>
        <button title="Back" style={ghostBtn()} onClick={() => frameRef.current?.contentWindow?.history.back()}>←</button>
        <button title="Forward" style={ghostBtn()} onClick={() => frameRef.current?.contentWindow?.history.forward()}>→</button>
        <button title="Reload preview only" style={ghostBtn()} onClick={() => { setFailed(false); setFrameKey((n) => n + 1); }}>
          <IconRefresh size={12} />
        </button>
        <input
          value={url}
          readOnly
          onClick={(e) => (e.target as HTMLInputElement).select()}
          title="Copy URL"
          style={{
            flex: 1,
            minWidth: 0,
            background: "var(--orvyn-surface-2)",
            border: "1px solid var(--orvyn-border-soft)",
            borderRadius: 6,
            color: "var(--orvyn-text)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            padding: "4px 8px",
          }}
        />
        <span style={{ fontSize: 10, color: live && !failed ? "var(--orvyn-green)" : "var(--orvyn-text-muted)", padding: "0 4px" }}>
          {local && !failed ? "Live" : "Snapshot"}
        </span>
        <button title="Open externally" style={ghostBtn()} onClick={() => void openExternalSafe(target.url)}>
          <IconExternal size={12} />
        </button>
        <button title="Expand preview" style={ghostBtn()} onClick={onExpand}>
          <IconExpand size={12} />
        </button>
        {onClose && (
          <button title="Close tab" style={ghostBtn()} onClick={onClose}>×</button>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, position: "relative", background: "#0b1020" }}>
        {!local && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 28, textAlign: "center", zIndex: 2, background: "var(--orvyn-surface-1)" }}>
            <div style={emptyTitle()}>Remote preview unavailable</div>
            <div style={emptyBody()}>
              Preview is available only for local workspace URLs. Remote worker ports are not exposed publicly.
            </div>
            {snapshot && <img src={snapshot} alt="Preview snapshot" style={{ maxWidth: "90%", maxHeight: 280, borderRadius: 8, border: "1px solid var(--orvyn-border-soft)" }} />}
            <button style={ghostBtn()} onClick={() => void openExternalSafe(target.url)}>Open externally</button>
          </div>
        )}
        {local && failed && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 28, textAlign: "center", zIndex: 2 }}>
            <div style={emptyTitle()}>Preview unavailable</div>
            <div style={emptyBody()}>The local server at {target.url} did not respond. Start it again, or close this tab.</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={ghostBtn()} onClick={() => { setFailed(false); setFrameKey((n) => n + 1); }}>Retry</button>
              {onClose && <button style={ghostBtn()} onClick={onClose}>Close tab</button>}
            </div>
          </div>
        )}
        {local && safe && (
          <iframe
            key={`${target.url}:${frameKey}`}
            ref={frameRef}
            title={target.label}
            src={target.url}
            onError={() => setFailed(true)}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            style={{ width: "100%", height: "100%", border: "none", background: "#fff" }}
          />
        )}
        <OrionCursorOverlay cursor={cursor ?? null} status={status} />
      </div>
    </div>
  );
}
