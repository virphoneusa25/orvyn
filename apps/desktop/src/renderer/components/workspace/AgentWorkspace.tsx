import React, { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent } from "../AgentActivityList";
import {
  applyManualTab,
  deriveAgentWorkspace,
  deriveReviewSummary,
  followApplies,
  followedSurfaceId,
  initialFollowState,
  mapContextTab,
  parseSurfaceTabId,
  resumeFollow,
  toggleFollow,
  type FollowController,
  type InspectorTab,
  type SurfaceTabId,
} from "../../agentWorkspaceModel";
import {
  clampInspectorWidth,
  clampWorkSurfaceWidth,
  INSPECTOR_MIN,
  WORK_SURFACE_MIN,
  type DesktopLayoutState,
} from "../../desktopLayout";
import { InspectorPanel } from "./InspectorPanel";
import { WorkSurface } from "./WorkSurface";
import { splitHandle } from "./workspaceChrome";

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
  const [drag, setDrag] = useState<null | "surface" | "inspector">(null);
  const start = useRef({ x: 0, surface: layout.workSurfaceWidth, inspector: layout.inspectorWidth });

  const surfaceTab = layout.surfaceTab;
  const inspectorTab = (layout.inspectorTab as InspectorTab) || "files";
  const inspectorOpen = layout.inspectorOpen && !layout.expandedPreview;
  const visiblePreviews = derived.previews.filter((p) => !closedPreviews.includes(p.url));
  const derivedVisible = useMemo(
    () => ({ ...derived, previews: visiblePreviews }),
    [derived, visiblePreviews]
  );

  useEffect(() => {
    if (running && layout.followOrion && !follow.followOrion) {
      setFollow(initialFollowState(true));
    }
  }, [running, layout.followOrion, follow.followOrion]);

  useEffect(() => {
    if (!followApplies(follow)) return;
    const nextSurface = followedSurfaceId({ ...derived, previews: visiblePreviews });
    const nextInspector = derived.suggestedInspector;
    const patch: Partial<DesktopLayoutState> = {};
    if (nextSurface && nextSurface !== surfaceTab) patch.surfaceTab = nextSurface;
    if (nextInspector && nextInspector !== inspectorTab) patch.inspectorTab = nextInspector;
    if (derived.activity?.file) setSelectedDiff(derived.activity.file);
    if (Object.keys(patch).length) onLayout(patch);
  }, [derived.activity, derived.suggestedSurface, derived.suggestedInspector, visiblePreviews.length, follow]);

  useEffect(() => {
    const onCtxTab = (e: Event) => {
      const detail = (e as CustomEvent<{ tab?: string }>).detail;
      const mapped = mapContextTab(detail?.tab);
      setFollow((s) => applyManualTab(s));
      const patch: Partial<DesktopLayoutState> = {};
      if (mapped.surface) patch.surfaceTab = mapped.surface;
      if (mapped.inspector) patch.inspectorTab = mapped.inspector;
      if (Object.keys(patch).length) onLayout(patch);
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
        ...(mapped.surface ? { surfaceTab: mapped.surface } : {}),
        ...(mapped.inspector ? { inspectorTab: mapped.inspector } : {}),
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
    if (!drag) return;
    function onMove(e: MouseEvent) {
      const dx = e.clientX - start.current.x;
      if (drag === "surface") {
        onLayout({ workSurfaceWidth: clampWorkSurfaceWidth(start.current.surface + dx, window.innerWidth, inspectorOpen, layout.inspectorWidth) });
      } else {
        onLayout({ inspectorWidth: clampInspectorWidth(start.current.inspector - dx, window.innerWidth) });
      }
    }
    function onUp() {
      setDrag(null);
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
  }, [drag, inspectorOpen, layout.inspectorWidth, onLayout]);

  function selectSurface(id: SurfaceTabId, manual = true) {
    if (manual) setFollow((s) => applyManualTab(s));
    onLayout({ surfaceTab: id, expandedPreview: false });
  }

  function selectInspector(tab: InspectorTab, manual = true) {
    if (manual) setFollow((s) => applyManualTab(s));
    onLayout({ inspectorTab: tab, inspectorOpen: true });
  }

  function onFollowClick() {
    const next = follow.paused ? resumeFollow() : toggleFollow(follow);
    setFollow(next);
    onLayout({ followOrion: next.followOrion });
  }

  const surfaceWidth = layout.expandedPreview
    ? Math.max(WORK_SURFACE_MIN, window.innerWidth - 240)
    : clampWorkSurfaceWidth(layout.workSurfaceWidth, typeof window !== "undefined" ? window.innerWidth : 1440, inspectorOpen, layout.inspectorWidth);
  const inspectorWidth = inspectorOpen ? clampInspectorWidth(layout.inspectorWidth) : 0;

  return (
    <div
      className="orvyn-agent-workspace"
      style={{
        display: "flex",
        height: "100%",
        minWidth: 0,
        position: "relative",
        flex: layout.expandedPreview ? 1 : "0 0 auto",
      }}
    >
      <div
        onMouseDown={(e) => {
          start.current = { x: e.clientX, surface: layout.workSurfaceWidth, inspector: layout.inspectorWidth };
          setDrag("surface");
        }}
        title="Drag to resize work surface"
        style={splitHandle(drag === "surface")}
        onMouseEnter={(e) => {
          if (!drag) e.currentTarget.style.background = "rgba(34,211,238,0.28)";
        }}
        onMouseLeave={(e) => {
          if (!drag) e.currentTarget.style.background = "transparent";
        }}
      />
      <div style={{ width: surfaceWidth, minWidth: WORK_SURFACE_MIN, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <WorkSurface
          derived={derivedVisible}
          surfaceTab={surfaceTab}
          follow={follow}
          running={running}
          onSelectTab={(id) => selectSurface(id, true)}
          onSelectDiff={(path) => {
            setSelectedDiff(path);
            selectInspector("diff", true);
          }}
          onFollowClick={onFollowClick}
          onExpand={() => onLayout({ expandedPreview: !layout.expandedPreview })}
          onClosePreview={(url) => {
            setClosedPreviews((list) => [...list, url]);
            const parsed = parseSurfaceTabId(surfaceTab);
            if (parsed.previewUrl === url) onLayout({ surfaceTab: "changes" });
          }}
          onOpenPlus={(kind) => selectSurface(kind, true)}
        />
        {layout.expandedPreview && (
          <button
            onClick={() => onLayout({ expandedPreview: false })}
            style={{
              position: "absolute",
              top: 40,
              right: 16,
              zIndex: 30,
              background: "var(--orvyn-surface-2)",
              border: "1px solid var(--orvyn-border)",
              color: "var(--orvyn-text)",
              borderRadius: 6,
              fontSize: 11,
              padding: "4px 10px",
              cursor: "pointer",
            }}
          >
            Restore layout
          </button>
        )}
      </div>
      {inspectorOpen && (
        <>
          <div
            onMouseDown={(e) => {
              start.current = { x: e.clientX, surface: layout.workSurfaceWidth, inspector: layout.inspectorWidth };
              setDrag("inspector");
            }}
            title="Drag to resize inspector"
            style={splitHandle(drag === "inspector")}
            onMouseEnter={(e) => {
              if (!drag) e.currentTarget.style.background = "rgba(34,211,238,0.28)";
            }}
            onMouseLeave={(e) => {
              if (!drag) e.currentTarget.style.background = "transparent";
            }}
          />
          <div style={{ width: inspectorWidth, minWidth: INSPECTOR_MIN, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <InspectorPanel
              derived={derivedVisible}
              events={events}
              tab={inspectorTab}
              runStatus={runStatus}
              runId={runId ?? undefined}
              projectRoot={projectRoot}
              focus={focus}
              selectedDiff={selectedDiff}
              review={review}
              onSelectTab={(t) => selectInspector(t, true)}
              onSelectDiff={(path) => setSelectedDiff(path)}
              onOpenFile={onOpenFile}
              onPreviewArtifact={(path) => selectSurface(`artifact:${path}`, true)}
            />
          </div>
        </>
      )}
    </div>
  );
}
