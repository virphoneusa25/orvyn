import React, { useState } from "react";
import type { AgentWorkspaceDerived, PreviewTarget, SurfaceTabId } from "../../agentWorkspaceModel";
import { parseSurfaceTabId } from "../../agentWorkspaceModel";
import { IconCrosshair, IconMore, IconPlus } from "../Icons";
import { AgentActivityHeader } from "./AgentActivityHeader";
import { ArtifactView } from "./ArtifactView";
import { BrowserView } from "./BrowserView";
import { ChangesView } from "./ChangesView";
import { DesktopView } from "./DesktopView";
import { PreviewView } from "./PreviewView";
import { iconBtn, tabBtn } from "./workspaceChrome";

export function WorkSurface({
  derived,
  surfaceTab,
  follow,
  running,
  onSelectTab,
  onSelectDiff,
  onFollowClick,
  onExpand,
  onClosePreview,
  onOpenPlus,
}: {
  derived: AgentWorkspaceDerived;
  surfaceTab: string;
  follow: { followOrion: boolean; paused: boolean };
  running: boolean;
  onSelectTab: (id: SurfaceTabId) => void;
  onSelectDiff: (path: string) => void;
  onFollowClick: () => void;
  onExpand: () => void;
  onClosePreview: (url: string) => void;
  onOpenPlus: (kind: "browser" | "changes" | "desktop") => void;
}) {
  const parsed = parseSurfaceTabId(surfaceTab);
  const [plusOpen, setPlusOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const preview = parsed.previewUrl
    ? derived.previews.find((p) => p.url === parsed.previewUrl) ?? derived.previews[0]
    : parsed.kind === "preview"
      ? derived.previews[0]
      : undefined;
  const artifact = parsed.artifact ? derived.artifacts.find((a) => a.path === parsed.artifact) : undefined;
  const followActive = follow.followOrion && !follow.paused;

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--orvyn-surface-1)" }}>
      <div style={{ display: "flex", alignItems: "center", height: 32, borderBottom: "1px solid var(--orvyn-border-soft)", padding: "0 4px", flexShrink: 0 }}>
        <SurfaceTab label="Changes" active={parsed.kind === "changes" && !parsed.artifact} onClick={() => onSelectTab("changes")} />
        <SurfaceTab label="Desktop" active={parsed.kind === "desktop"} onClick={() => onSelectTab("desktop")} />
        <SurfaceTab label="Browser" active={parsed.kind === "browser"} onClick={() => onSelectTab("browser")} />
        {derived.previews.map((p) => (
          <SurfaceTab
            key={p.url}
            label={p.label}
            active={parsed.kind === "preview" && (parsed.previewUrl ?? preview?.url) === p.url}
            onClick={() => onSelectTab(`preview:${p.url}`)}
          />
        ))}
        <div style={{ position: "relative" }}>
          <button title="Open surface" style={iconBtn(plusOpen)} onClick={() => setPlusOpen((v) => !v)}>
            <IconPlus size={13} />
          </button>
          {plusOpen && (
            <div style={menuBox()}>
              {(["changes", "desktop", "browser"] as const).map((k) => (
                <button key={k} style={menuItem()} onClick={() => { onOpenPlus(k); setPlusOpen(false); }}>
                  {k[0]!.toUpperCase() + k.slice(1)}
                </button>
              ))}
            </div>
          )}
        </div>
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 2 }}>
          {follow.paused && follow.followOrion && (
            <span style={{ fontSize: 10, color: "var(--orvyn-yellow)", paddingRight: 4 }}>Follow paused</span>
          )}
          <button
            title={follow.paused ? "Resume following" : followActive ? "Follow ORION activity" : "Follow ORION activity"}
            style={iconBtn(followActive)}
            onClick={onFollowClick}
          >
            <IconCrosshair size={14} />
          </button>
          <div style={{ position: "relative" }}>
            <button title="More views" style={iconBtn(moreOpen)} onClick={() => setMoreOpen((v) => !v)}>
              <IconMore size={14} />
            </button>
            {moreOpen && (
              <div style={{ ...menuBox(), right: 0, left: "auto" }}>
                <button style={menuItem()} onClick={() => { onSelectTab("changes"); setMoreOpen(false); }}>Plan / Docs live in Inspector ·••</button>
              </div>
            )}
          </div>
        </span>
      </div>
      <AgentActivityHeader line={derived.activity?.line} running={running} waitingApproval={derived.waitingApproval} />
      {parsed.kind === "changes" && !artifact && (
        <ChangesView
          files={derived.files}
          diffs={derived.diffs}
          summary={derived.changeSummary}
          selected={derived.activity?.file}
          onSelect={onSelectDiff}
        />
      )}
      {parsed.kind === "desktop" && <DesktopView />}
      {parsed.kind === "browser" && <BrowserView browser={derived.browser} status={derived.activity?.surface === "browser" ? derived.activity.line : null} />}
      {parsed.kind === "preview" && (
        <PreviewView
          target={preview as PreviewTarget | undefined}
          cursor={derived.browser.cursor}
          status={derived.activity?.surface === "preview" ? derived.activity.line : null}
          live={Boolean(preview?.local)}
          snapshot={derived.browser.actions.find((a) => a.snapshot)?.snapshot}
          onExpand={onExpand}
          onClose={preview ? () => onClosePreview(preview.url) : undefined}
        />
      )}
      {artifact && <ArtifactView name={artifact.path} />}
    </div>
  );
}

function SurfaceTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={tabBtn(active)}>
      {label}
    </button>
  );
}

function menuBox(): React.CSSProperties {
  return {
    position: "absolute",
    top: 28,
    left: 0,
    zIndex: 20,
    minWidth: 140,
    background: "var(--orvyn-surface-2)",
    border: "1px solid var(--orvyn-border)",
    borderRadius: 8,
    padding: 4,
    boxShadow: "var(--orvyn-shadow)",
  };
}

function menuItem(): React.CSSProperties {
  return {
    display: "block",
    width: "100%",
    background: "transparent",
    border: "none",
    color: "var(--orvyn-text-secondary)",
    textAlign: "left",
    fontSize: 12,
    padding: "6px 8px",
    cursor: "pointer",
    borderRadius: 5,
  };
}
