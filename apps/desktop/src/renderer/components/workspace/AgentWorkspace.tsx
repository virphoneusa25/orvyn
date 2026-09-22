import React, { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent } from "../AgentActivityList";
import {
  applyManualTab,
  deriveAgentWorkspace,
  deriveReviewSummary,
  followApplies,
  followedPreviewUrl,
  initialFollowState,
  mapContextTab,
  OVERFLOW_WORKSPACE_TABS,
  PRIMARY_WORKSPACE_TABS,
  resumeFollow,
  toggleFollow,
  type AgentWorkspaceTab,
  type FollowController,
  type PreviewTarget,
} from "../../agentWorkspaceModel";
import {
  AGENT_WORKSPACE_TABBAR_TEST_ID,
  AGENT_WORKSPACE_TEST_ID,
  assertSingleAgentWorkspace,
  countRightColumns,
  followActiveTab,
} from "../../agentWorkspaceLayout";
import {
  AGENT_PANEL_MIN,
  clampAgentPanelWidth,
  shouldOverlayAgentPanel,
  SIDEBAR_WIDTH,
  type DesktopLayoutState,
} from "../../desktopLayout";
import { DocumentsPanel } from "../DocumentsPanel";
import { MissionPlan } from "../MissionPlan";
import { IconClose, IconCrosshair, IconMore } from "../Icons";
import { AgentActivityHeader } from "./AgentActivityHeader";
import { ArtifactView } from "./ArtifactView";
import { BrowserView } from "./BrowserView";
import { ChangesView } from "./ChangesView";
import { DesktopView } from "./DesktopView";
import { DiffInspector } from "./DiffInspector";
import { FilesInspector } from "./FilesInspector";
import { PreviewView } from "./PreviewView";
import { ReviewInspector } from "./ReviewInspector";
import { TerminalInspector } from "./TerminalInspector";
import { iconBtn, splitHandle, tabBtn } from "./workspaceChrome";

export function AgentWorkspacePanel(props: {
  events: AgentEvent[];
  runStatus: string;
  runId?: string | null;
  projectRoot: string | null;
  projectName?: string | null;
  layout: DesktopLayoutState;
  onLayout: (patch: Partial<DesktopLayoutState>) => void;
  onOpenFile: (path: string) => void;
}) {
  return <AgentWorkspace {...props} />;
}

export function AgentWorkspace({
  events,
  runStatus,
  runId,
  projectRoot,
  projectName,
  layout,
  onLayout,
  onOpenFile,
}: {
  events: AgentEvent[];
  runStatus: string;
  runId?: string | null;
  projectRoot: string | null;
  projectName?: string | null;
  layout: DesktopLayoutState;
  onLayout: (patch: Partial<DesktopLayoutState>) => void;
  onOpenFile: (path: string) => void;
}) {
  const derived = useMemo(
    () => deriveAgentWorkspace(events, { projectName }),
    [events, projectName]
  );
  const review = useMemo(() => deriveReviewSummary(events, derived), [events, derived]);
  const running = runStatus === "running" || runStatus === "streaming" || runStatus === "working";

  const [follow, setFollow] = useState<FollowController>(() =>
    initialFollowState(running && layout.followOrion !== false)
  );
  const [focus, setFocus] = useState<{ path?: string; fileName?: string } | null>(null);
  const [selectedDiff, setSelectedDiff] = useState<string | null>(null);
  const [closedPreviews, setClosedPreviews] = useState<string[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1440));
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, width: layout.agentPanelWidth });
  const rootRef = useRef<HTMLDivElement | null>(null);

  const activeTab = layout.activeTab;
  const visiblePreviews = derived.previews.filter((p) => !closedPreviews.includes(p.url));
  const preview =
    visiblePreviews.find((p) => p.url === layout.previewUrl) ??
    visiblePreviews.find((p) => p.url === derived.activity?.previewUrl) ??
    visiblePreviews[0];
  const overlay = shouldOverlayAgentPanel(viewportWidth);
  const overflowActive = OVERFLOW_WORKSPACE_TABS.some((t) => t.id === activeTab);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const root = rootRef.current?.ownerDocument ?? (typeof document !== "undefined" ? document : null);
    if (!root) return;
    try {
      assertSingleAgentWorkspace(root);
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    if (running && layout.followOrion && !follow.followOrion) {
      setFollow(initialFollowState(true));
    }
  }, [running, layout.followOrion, follow.followOrion]);

  useEffect(() => {
    if (!followApplies(follow)) return;
    const nextTab = followActiveTab(derived.activity, activeTab);
    const patch: Partial<DesktopLayoutState> = {};
    if (nextTab !== activeTab) patch.activeTab = nextTab;
    if (nextTab === "preview") {
      const url = followedPreviewUrl({ ...derived, previews: visiblePreviews });
      if (url && url !== layout.previewUrl) patch.previewUrl = url;
    }
    if (derived.activity?.file) setSelectedDiff(derived.activity.file);
    if (Object.keys(patch).length) onLayout(patch);
  }, [derived.activity, visiblePreviews.length, follow, activeTab, layout.previewUrl, onLayout]);

  useEffect(() => {
    const onCtxTab = (e: Event) => {
      const detail = (e as CustomEvent<{ tab?: string }>).detail;
      const mapped = mapContextTab(detail?.tab);
      setFollow((s) => applyManualTab(s));
      if (mapped) onLayout({ activeTab: mapped, rightPanelOpen: true });
    };
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<{ tab?: string; path?: string; fileName?: string }>).detail;
      if (!d?.tab) return;
      const mapped = mapContextTab(d.tab);
      setFollow((s) => applyManualTab(s));
      setFocus(d.path || d.fileName ? { path: d.path, fileName: d.fileName } : null);
      if (d.path) setSelectedDiff(d.path);
      onLayout({
        rightPanelOpen: true,
        ...(mapped ? { activeTab: mapped } : {}),
      });
    };
    document.addEventListener("orvyn:context-tab", onCtxTab);
    document.addEventListener("orvyn:context-open", onOpen);
    return () => {
      document.removeEventListener("orvyn:context-tab", onCtxTab);
      document.removeEventListener("orvyn:context-open", onOpen);
    };
  }, [onLayout]);

  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      onLayout({ agentPanelWidth: clampAgentPanelWidth(start.current.width - (e.clientX - start.current.x), window.innerWidth) });
    }
    function onUp() {
      setDragging(false);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragging, onLayout]);

  function selectTab(tab: AgentWorkspaceTab, manual = true, previewUrl?: string) {
    if (manual) setFollow((s) => applyManualTab(s));
    setMoreOpen(false);
    onLayout({
      activeTab: tab,
      expandedPreview: false,
      ...(previewUrl ? { previewUrl } : {}),
    });
  }

  function onFollowClick() {
    const next = follow.paused ? resumeFollow() : toggleFollow(follow);
    setFollow(next);
    onLayout({ followOrion: next.followOrion });
  }

  function closeWorkspace() {
    onLayout({ rightPanelOpen: false });
  }

  const width = layout.expandedPreview
    ? Math.max(AGENT_PANEL_MIN, viewportWidth - SIDEBAR_WIDTH - 24)
    : clampAgentPanelWidth(layout.agentPanelWidth, viewportWidth);
  const followActive = follow.followOrion && !follow.paused;
  const columns = countRightColumns({ rightPanelOpen: true });

  return (
    <div
      ref={rootRef}
      className="orvyn-agent-workspace"
      data-testid={AGENT_WORKSPACE_TEST_ID}
      data-right-columns={columns}
      data-active-tab={activeTab}
      data-overlay={overlay ? "true" : "false"}
      style={{
        display: "flex",
        height: "100%",
        width: overlay ? width : "100%",
        minWidth: overlay ? AGENT_PANEL_MIN : 0,
        maxWidth: overlay ? Math.floor(viewportWidth * 0.7) : "100%",
        minHeight: 0,
        position: overlay ? "absolute" : "relative",
        top: overlay ? 0 : undefined,
        right: overlay ? 0 : undefined,
        bottom: overlay ? 0 : undefined,
        zIndex: overlay ? 24 : undefined,
        boxShadow: overlay ? "var(--orvyn-shadow)" : undefined,
        background: "var(--orvyn-surface-1)",
        borderLeft: "1px solid var(--orvyn-border-soft)",
      }}
    >
      <div
        onMouseDown={(e) => {
          start.current = { x: e.clientX, width: layout.agentPanelWidth };
          setDragging(true);
        }}
        title="Drag to resize Agent Workspace"
        style={splitHandle(dragging)}
        onMouseEnter={(e) => {
          if (!dragging) e.currentTarget.style.background = "rgba(34,211,238,0.28)";
        }}
        onMouseLeave={(e) => {
          if (!dragging) e.currentTarget.style.background = "transparent";
        }}
      />
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div
          data-testid={AGENT_WORKSPACE_TABBAR_TEST_ID}
          style={{
            display: "flex",
            alignItems: "center",
            height: 32,
            borderBottom: "1px solid var(--orvyn-border-soft)",
            padding: "0 4px",
            flexShrink: 0,
            minWidth: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", minWidth: 0, overflowX: "auto", flex: 1 }}>
            {PRIMARY_WORKSPACE_TABS.map((t) => (
              <button
                key={t.id}
                data-tab={t.id}
                onClick={() => selectTab(t.id, true, t.id === "preview" ? preview?.url : undefined)}
                style={tabBtn(activeTab === t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <span style={{ marginLeft: 4, display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
            {follow.paused && follow.followOrion && (
              <span style={{ fontSize: 10, color: "var(--orvyn-yellow)", paddingRight: 4 }}>Follow paused</span>
            )}
            <div style={{ position: "relative" }}>
              <button
                title="Plan, Docs, Desktop"
                style={iconBtn(moreOpen || overflowActive)}
                onClick={() => setMoreOpen((v) => !v)}
              >
                <IconMore size={14} />
              </button>
              {moreOpen && (
                <div
                  style={{
                    position: "absolute",
                    right: 0,
                    top: 28,
                    zIndex: 20,
                    minWidth: 128,
                    background: "var(--orvyn-surface-2)",
                    border: "1px solid var(--orvyn-border)",
                    borderRadius: 8,
                    padding: 4,
                    boxShadow: "var(--orvyn-shadow)",
                  }}
                >
                  {OVERFLOW_WORKSPACE_TABS.map((t) => (
                    <button
                      key={t.id}
                      style={overflowItem(activeTab === t.id)}
                      onClick={() => selectTab(t.id, true)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              title={follow.paused ? "Resume following ORION" : followActive ? "Following ORION" : "Follow ORION"}
              style={iconBtn(followActive)}
              onClick={onFollowClick}
            >
              <IconCrosshair size={14} />
            </button>
            <button title="Close Agent Workspace" style={iconBtn()} onClick={closeWorkspace}>
              <IconClose size={13} />
            </button>
          </span>
        </div>
        <AgentActivityHeader line={derived.activity?.line} running={running} waitingApproval={derived.waitingApproval} />
        <WorkspaceView
          tab={activeTab}
          derived={{ ...derived, previews: visiblePreviews }}
          events={events}
          review={review}
          runStatus={runStatus}
          runId={runId ?? undefined}
          projectRoot={projectRoot}
          focus={focus}
          selectedDiff={selectedDiff}
          preview={preview}
          onSelectTab={(tab) => selectTab(tab, true)}
          onSelectDiff={(path) => {
            setSelectedDiff(path);
            selectTab("diff", true);
          }}
          onOpenFile={onOpenFile}
          onPreviewArtifact={() => selectTab("docs", true)}
          onExpand={() => onLayout({ expandedPreview: !layout.expandedPreview })}
          onClosePreview={(url) => {
            setClosedPreviews((list) => [...list, url]);
            if (layout.previewUrl === url) onLayout({ previewUrl: "", activeTab: "changes" });
          }}
        />
      </div>
    </div>
  );
}

function WorkspaceView({
  tab,
  derived,
  events,
  review,
  runStatus,
  runId,
  projectRoot,
  focus,
  selectedDiff,
  preview,
  onSelectTab,
  onSelectDiff,
  onOpenFile,
  onPreviewArtifact,
  onExpand,
  onClosePreview,
}: {
  tab: AgentWorkspaceTab;
  derived: ReturnType<typeof deriveAgentWorkspace>;
  events: AgentEvent[];
  review: ReturnType<typeof deriveReviewSummary>;
  runStatus: string;
  runId?: string;
  projectRoot: string | null;
  focus: { path?: string; fileName?: string } | null;
  selectedDiff: string | null;
  preview?: PreviewTarget;
  onSelectTab: (tab: AgentWorkspaceTab) => void;
  onSelectDiff: (path: string) => void;
  onOpenFile: (path: string) => void;
  onPreviewArtifact: (path: string) => void;
  onExpand: () => void;
  onClosePreview: (url: string) => void;
}) {
  if (tab === "preview") {
    return (
      <PreviewView
        target={preview}
        cursor={derived.browser.cursor}
        status={derived.activity?.tab === "preview" ? derived.activity.line : null}
        live={Boolean(preview?.local)}
        snapshot={derived.browser.actions.find((a) => a.snapshot)?.snapshot}
        onExpand={onExpand}
        onClose={preview ? () => onClosePreview(preview.url) : undefined}
      />
    );
  }
  if (tab === "changes") {
    return (
      <ChangesView
        files={derived.files}
        diffs={derived.diffs}
        summary={derived.changeSummary}
        selected={selectedDiff ?? derived.activity?.file}
        onSelect={onSelectDiff}
      />
    );
  }
  if (tab === "files") {
    return (
      <FilesInspector
        files={derived.files}
        artifacts={derived.artifacts}
        projectRoot={projectRoot}
        focus={focus}
        activePath={selectedDiff ?? derived.activity?.file}
        onOpenFile={(path) => {
          onOpenFile(path);
          onSelectDiff(path);
        }}
        onPreviewArtifact={onPreviewArtifact}
      />
    );
  }
  if (tab === "diff") {
    return (
      <DiffInspector
        diffs={derived.diffs}
        focus={focus}
        selectedPath={selectedDiff ?? derived.activity?.file}
        onSelect={onSelectDiff}
      />
    );
  }
  if (tab === "terminal") {
    return <TerminalInspector events={events} />;
  }
  if (tab === "browser") {
    return (
      <BrowserView
        browser={derived.browser}
        status={derived.activity?.tab === "browser" ? derived.activity.line : null}
      />
    );
  }
  if (tab === "review") {
    return (
      <ReviewInspector
        runId={runId}
        summary={review}
        onOpenDiff={() => onSelectTab("diff")}
        onOpenTerminal={() => onSelectTab("terminal")}
      />
    );
  }
  if (tab === "plan") {
    return (
      <div style={{ flex: 1, overflowY: "auto", padding: 10 }}>
        <MissionPlan events={events} status={runStatus} />
      </div>
    );
  }
  if (tab === "docs") {
    const artifact = derived.artifacts[0];
    if (artifact) return <ArtifactView name={artifact.path} />;
    return <DocumentsPanel projectRoot={projectRoot} revision={derived.artifacts.length} />;
  }
  return <DesktopView />;
}

function overflowItem(active: boolean): React.CSSProperties {
  return {
    display: "block",
    width: "100%",
    background: active ? "rgba(108,92,255,0.12)" : "transparent",
    border: "none",
    color: "var(--orvyn-text-secondary)",
    textAlign: "left",
    fontSize: 12,
    padding: "6px 8px",
    cursor: "pointer",
    borderRadius: 5,
  };
}
