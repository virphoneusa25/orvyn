import { registerContextListener, takePendingContext } from "../../contextOpen";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent } from "../AgentActivityList";
import {
  applyManualTab,
  deriveAgentWorkspace,
  deriveReviewSummary,
  followApplies,
  initialFollowState,
  mapContextTab,
  resumeFollow,
  toggleFollow,
  type AgentWorkspaceTab,
  type FollowController,
} from "../../agentWorkspaceModel";
import { countRightColumns, followActiveTab } from "../../agentWorkspaceLayout";
import { planPreviewRefresh } from "../../previewRefresh";
import {
  AGENT_PANEL_MIN,
  clampAgentPanelWidth,
  shouldOverlayAgentPanel,
  SIDEBAR_WIDTH,
  type DesktopLayoutState,
} from "../../desktopLayout";
import {
  artifactTabId,
  closeTab,
  diffTabId,
  fileTabId,
  followWorkbenchTab,
  nextTerminalTabId,
  parseWorkbenchTab,
  previewTabId,
  reconcileWorkbenchTabs,
  upsertTab,
  urlsMatch,
  WORKBENCH_TABBAR_TEST_ID,
  WORKBENCH_TEST_ID,
  workbenchTabCloseEffect,
  type WorkbenchTab,
  type WorkbenchTabKind,
} from "../../workbenchModel";
import { isFabricatedGeneratedPath } from "../../workbenchFileAccess";
import { environmentLabel, resolveWorkbenchEnvironment, terminalTitle, workspaceChromeStatus } from "../../workbenchEnvironment";
import { previewUrlForSelection, projectWorkbench, shouldListDisk, workspaceChromeLabel, type WorkbenchSessionSnapshot, type WorkbenchSurface } from "../../workbenchBinding";
import { readComposerDefaults } from "../../composerSettings";
import { isCloudBackend, getConnectionConfig } from "../../connection";
import { DocumentsPanel } from "../DocumentsPanel";
import { MissionPlan } from "../MissionPlan";
import {
  IconCheck,
  IconClose,
  IconCrosshair,
  IconExpand,
  IconFile,
  IconFolder,
  IconGit,
  IconGlobe,
  IconImage,
  IconList,
  IconMonitor,
  IconPlug,
  IconPlus,
  IconServer,
  IconTerminal,
} from "../Icons";
import type { WorkbenchBrowserState } from "../../orvyn-bridge";
import { ArtifactView } from "./ArtifactView";
import { BrowserWorkbench } from "./BrowserWorkbench";
import { ChangesView } from "./ChangesView";
import { DesktopView } from "./DesktopView";
import { DiffInspector } from "./DiffInspector";
import { FileEditorView } from "./FileEditorView";
import { EnvironmentView } from "./EnvironmentView";
import { FilesInspector } from "./FilesInspector";
import { PortsPanel } from "./PortsPanel";
import { ReviewInspector } from "./ReviewInspector";
import { TerminalInspector } from "./TerminalInspector";
import { useWorkbenchPorts } from "./useWorkbenchPorts";
import { WorkbenchLauncher } from "./WorkbenchLauncher";
import { WORKBENCH_Z, WorkbenchPopover } from "./WorkbenchOverlay";
import { usePlusQuery, WorkbenchPlusMenu } from "./WorkbenchPlusMenu";
import { splitHandle } from "./workspaceChrome";
import "./workbenchChrome.css";

export function AgentWorkspacePanel(props: Parameters<typeof AgentWorkspace>[0]) {
  return <AgentWorkspace {...props} />;
}

export function AgentWorkspace({
  events,
  runStatus,
  runId,
  projectRoot,
  projectName,
  session = null,
  layout,
  onLayout,
  onOpenFile,
}: {
  events: AgentEvent[];
  runStatus: string;
  runId?: string | null;
  projectRoot: string | null;
  projectName?: string | null;
  /** Restored WorkSession identity. Live workspace.resolved events override it. */
  session?: WorkbenchSessionSnapshot | null;
  layout: DesktopLayoutState;
  onLayout: (patch: Partial<DesktopLayoutState>) => void;
  onOpenFile: (path: string) => void;
}) {
  const derived = useMemo(() => deriveAgentWorkspace(events, { projectName }), [events, projectName]);
  const surface = useMemo(() => projectWorkbench({ events, session, guessedRoot: projectRoot }), [events, session, projectRoot]);
  const boundRoot = surface.listRoot;
  const headerLabel = workspaceChromeLabel(surface, projectName, projectRoot, boundRoot);
  const listDisk = shouldListDisk(boundRoot, projectRoot);
  const review = useMemo(() => deriveReviewSummary(events, derived), [events, derived]);
  const running = runStatus === "running" || runStatus === "streaming" || runStatus === "working";
  const websiteRun = events.some((event) => event.type === "run.started" && event.data?.requiresFrontend === true);
  const previewPreparing = running && websiteRun && !events.some((event) => event.type === "preview.available");
  const [follow, setFollow] = useState<FollowController>(() => initialFollowState(running && layout.followOrion !== false));
  const [plusOpen, setPlusOpen] = useState(false);
  const [portsOpen, setPortsOpen] = useState(false);
  const [filesFocus, setFilesFocus] = useState<{ path?: string; fileName?: string; artifactId?: string; user?: boolean } | null>(null);
  const plusQuery = usePlusQuery();
  const plusBtnRef = useRef<HTMLButtonElement | null>(null);
  const portsBtnRef = useRef<HTMLButtonElement | null>(null);
  const [browserState, setBrowserState] = useState<WorkbenchBrowserState>({ tabs: [], recents: [], activeId: null });
  const [addressFocus, setAddressFocus] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1440));
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, width: layout.agentPanelWidth });
  const previewSeeded = useRef(new Set<string>());
  const followRef = useRef(follow);
  followRef.current = follow;
  const desktopLive = events.some((e) => String(e.type).startsWith("desktop.") && e.type !== "desktop.completed" && e.type !== "desktop.failed");

  const executionActual = [...events].reverse().find((e) => e.type === "run.execution")?.data?.executionTargetActual
    ?? [...events].reverse().find((e) => e.type === "run.execution")?.data?.executionTargetRequested;
  const environment = resolveWorkbenchEnvironment({
    executionActual: executionActual != null ? String(executionActual) : undefined,
    executionTarget: readComposerDefaults().executionTarget,
    cloudBackend: isCloudBackend(getConnectionConfig().backendUrl),
  });
  const eventText = events.map((e) => String(e.data?.output ?? e.data?.preview ?? e.data?.chunk ?? "")).join("\n");
  const ports = useWorkbenchPorts({ environment, runId, projectRoot: boundRoot, eventText });

  const previewVersion = useMemo(() => {
    const updates = events.filter((e) => e.type === "preview.available").length;
    if (updates > 0) return updates;
    return derived.previews.length > 0 ? 1 : 0;
  }, [events, derived.previews.length]);

  const previewUrl = (surface.previewOpensAutomatically ? surface.previewUrl : null)
    || (surface.status === "none" ? undefined : derived.previews[derived.previews.length - 1]?.url)
    || undefined;
  const reconciled = useMemo(() => reconcileWorkbenchTabs({
    openTabIds: layout.openTabIds,
    activeTabId: layout.activeTabId,
    previewUrl,
    browserTabs: browserState.tabs,
  }), [layout.openTabIds, layout.activeTabId, previewUrl, browserState.tabs]);
  const tabs = reconciled.tabs;
  const activeId = reconciled.activeId;
  const openKey = layout.openTabIds.join("\n");
  const reconciledKey = reconciled.openTabIds.join("\n");
  useEffect(() => {
    if (reconciledKey === openKey && activeId === layout.activeTabId) return;
    if (!openKey && !layout.activeTabId) return;
    onLayout({ openTabIds: reconciled.openTabIds, activeTabId: activeId });
  }, [reconciledKey, openKey, activeId, layout.activeTabId, onLayout]);
  const active = tabs.find((t) => t.id === activeId);
  const emptyWorkbench = !active;
  const overlay = shouldOverlayAgentPanel(viewportWidth);
  const browserish = active?.kind === "browser" || active?.kind === "preview";
  const activeNative = active ? matchingNativeTab(browserState, active) : undefined;

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const api = window.orvyn.browser;
    if (!api) return;
    void api.list().then(setBrowserState);
    return api.onChange(setBrowserState);
  }, []);

  useEffect(() => {
    return () => {
      void window.orvyn.browser?.setVisible(false);
    };
  }, []);

  useEffect(() => {
    document.body.dataset.orvynWorkbench = browserish ? "browser" : "";
    return () => {
      delete document.body.dataset.orvynWorkbench;
    };
  }, [browserish]);

  useEffect(() => {
    if (running && layout.followOrion && !follow.followOrion) setFollow(initialFollowState(true));
  }, [running, layout.followOrion, follow.followOrion]);

  useEffect(() => {
    const api = window.orvyn.browser;
    if (!api) return;
    const latestUrl = previewUrl;
    const latest = latestUrl ? { url: latestUrl } : undefined;
    if (!latest?.url) return;
    const previewTab = parseWorkbenchTab(previewTabId(latest.url));
    const revealPreview = () => {
      if (!followApplies(followRef.current)) return;
      activate(previewTab, false);
    };
    const existing = browserState.tabs.find((t) => urlsMatch(t.url, latest.url)) ?? browserState.tabs.find((t) => t.kind === "preview");
    if (existing) {
      if (!urlsMatch(existing.url, latest.url)) {
        const key = `nav:${latest.url}`;
        if (previewSeeded.current.has(key)) return;
        previewSeeded.current.add(key);
        void api.navigate(existing.id, latest.url).then((state) => {
          setBrowserState(state);
          revealPreview();
        });
        return;
      }
      if (previewSeeded.current.has(latest.url)) return;
      previewSeeded.current.add(latest.url);
      // The tab may still hold the render from an earlier publish (or from a
      // different chat viewing the same site): a preview must open showing
      // the site as it is NOW, not the frame it happened to paint last.
      void api.reload(existing.id, { ignoreCache: true }).then((state) => setBrowserState(state));
      revealPreview();
      return;
    }
    if (previewSeeded.current.has(latest.url)) return;
    previewSeeded.current.add(latest.url);
    void api.create("preview", latest.url).then((state) => {
      setBrowserState(state);
      revealPreview();
    });
  }, [previewUrl, browserState.tabs]);

  const previewRevision = useMemo(() => {
    let revision = 0;
    for (const event of events) {
      if (event.type !== "preview.updated") continue;
      const next = Number(event.data?.revision ?? 0);
      if (next > revision) revision = next;
    }
    return revision;
  }, [events]);

  useEffect(() => {
    const api = window.orvyn.browser;
    if (!api || !previewRevision) return;
    const last = [...events].reverse().find((event) => event.type === "preview.updated");
    const plan = planPreviewRefresh({
      url: String(last?.data?.url ?? previewUrl ?? ""),
      revision: previewRevision,
      tabs: browserState.tabs,
      followActive: followApplies(followRef.current),
    });
    if (!plan) return;
    const key = `rev:${plan.revision}:${plan.reloadId}`;
    if (previewSeeded.current.has(key)) return;
    previewSeeded.current.add(key);
    void api.reload(plan.reloadId, { ignoreCache: true });
  }, [previewRevision, browserState.tabs, events, previewUrl]);
  useEffect(() => {
    if (previewUrl || !previewPreparing || !layout.followOrion || follow.paused || layout.activeTabId === "preview") return;
    const tab = parseWorkbenchTab("preview");
    onLayout({ rightPanelOpen: true, activeTab: "preview", activeTabId: tab.id, openTabIds: upsertTab(tabs, tab).map((item) => item.id) });
  }, [previewUrl, previewPreparing, layout.followOrion, layout.activeTabId, follow.paused, tabs]);

  useEffect(() => {
    if (!followApplies(follow)) return;
    if (previewPreparing && !previewUrl) return;
    const activity = derived.activity;
    if (!activity || activity.switchTab === false) return;
    const currentKind: AgentWorkspaceTab =
      !active ? "changes" : active.kind === "file" || active.kind === "artifact" ? "files" : (active.kind as AgentWorkspaceTab);
    let nextKind = followActiveTab(activity, currentKind);
    // A website with a live preview: writing its pages and styles updates the
    // preview, so the preview stays in front (like watching the site being
    // built); the file is still selected in Files.
    const siteFile = /\.(html?|css|js|mjs|svg)$/i.test(String(activity.file ?? ""));
    if (previewUrl && siteFile && (nextKind === "files" || nextKind === "diff")) {
      setFilesFocus({ path: activity.file, fileName: activity.file, artifactId: activity.artifactId, user: false });
      if (currentKind === "preview") return;
      nextKind = "preview";
    }
    const native = activity.previewUrl
      ? browserState.tabs.find((t) => urlsMatch(t.url, activity.previewUrl!))
      : browserState.activeId
        ? browserState.tabs.find((t) => t.id === browserState.activeId)
        : undefined;
    const next = followWorkbenchTab(nextKind === "diff" ? "diff" : nextKind, {
      url: activity.previewUrl ?? derived.previews[0]?.url,
      path: activity.file,
      name: activity.file,
      browserId: native && native.kind === "browser" ? native.id : undefined,
      artifactId: activity.artifactId,
    });
    if (nextKind === "files") {
      // Follow ORION: select the file in the list, but never take over the
      // center of the window while the user is reading the chat.
      setFilesFocus({ path: activity.file, fileName: activity.file, artifactId: activity.artifactId, user: false });
    }
    const merged = reconcileWorkbenchTabs({
      openTabIds: upsertTab(tabs, next).map((t) => t.id),
      activeTabId: next.id,
      previewUrl: next.url ?? previewUrl,
      browserTabs: browserState.tabs,
    });
    if (merged.activeId === activeId && merged.openTabIds.join("\n") === tabs.map((t) => t.id).join("\n")) return;
    onLayout({
      activeTabId: merged.activeId,
      activeTab: next.kind === "file" || next.kind === "artifact" ? "files" : (next.kind as DesktopLayoutState["activeTab"]),
      openTabIds: merged.openTabIds,
      previewUrl: next.url ?? layout.previewUrl,
    });
  }, [derived.activity, follow, activeId, browserState.tabs, browserState.activeId, previewPreparing, previewUrl]);

  useEffect(() => {
    const open = (e: Event) => {
      const d = (e as CustomEvent<{ tab?: string; path?: string; url?: string; fileName?: string; artifactId?: string }>).detail;
      const mapped = mapContextTab(d?.tab);
      setFollow((s) => applyManualTab(s));
      if (mapped === "files") {
        setFilesFocus({ path: d?.path, fileName: d?.fileName, artifactId: d?.artifactId, user: true });
        activate(parseWorkbenchTab("files"), true);
        return;
      }
      if (d?.path && mapped === "diff") {
        activate(parseWorkbenchTab(diffTabId(d.path)), true);
        return;
      }
      if (mapped === "browser" || mapped === "preview") {
        // A generated asset previews in the artifact viewer (the right pane),
        // not in a browser surface — no mission, no model call.
        if (d?.artifactId) {
          activate(parseWorkbenchTab(artifactTabId(d.fileName ?? d.path ?? "artifact", d.artifactId)), true);
          return;
        }
        void openBrowserSurface(mapped, d?.url ?? derived.activity?.previewUrl);
        return;
      }
      if (mapped) activate(parseWorkbenchTab(mapped), true);
    };
    document.addEventListener("orvyn:context-open", open);
    document.addEventListener("orvyn:context-tab", open);
    const unregister = registerContextListener();
    // A row clicked while the Workbench was closed: open what was clicked.
    const waiting = takePendingContext();
    if (waiting) open(new CustomEvent("orvyn:context-open", { detail: waiting }));
    return () => {
      unregister();
      document.removeEventListener("orvyn:context-open", open);
      document.removeEventListener("orvyn:context-tab", open);
    };
  }, [tabs, derived.activity?.previewUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        activate(parseWorkbenchTab("desktop"), true);
      }
      if (browserish && e.ctrlKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        e.stopPropagation();
        setAddressFocus((n) => n + 1);
      }
      if (browserish && e.ctrlKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        e.stopPropagation();
        const id = activeNative?.id ?? browserState.activeId;
        if (id) void window.orvyn.browser?.reload(id);
      }
      if (e.ctrlKey && e.key.toLowerCase() === "w" && active?.closable) {
        e.preventDefault();
        close(active.id);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [tabs, activeId, browserState.activeId, browserish, activeNative?.id]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => onLayout({ agentPanelWidth: clampAgentPanelWidth(start.current.width - (e.clientX - start.current.x), window.innerWidth) });
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
  }, [dragging, onLayout]);

  function activate(tab: WorkbenchTab, manual = false) {
    if (manual) setFollow((s) => applyManualTab(s));
    setPlusOpen(false);
    if ((tab.kind === "preview" || tab.id === "preview") && !tab.url) {
      const saved = previewUrlForSelection(surface, true);
      if (saved) {
        void openBrowserSurface("preview", saved);
        return;
      }
    }
      if (tab.id === "browser" && !browserState.tabs.some((t) => t.kind === "browser")) {
      void openBrowserSurface("browser");
      return;
    }
    const merged = reconcileWorkbenchTabs({
      openTabIds: upsertTab(tabs, tab).map((t) => t.id),
      activeTabId: tab.id,
      previewUrl: tab.url ?? previewUrl,
      browserTabs: browserState.tabs,
    });
    onLayout({
      rightPanelOpen: true,
      activeTabId: merged.activeId,
      activeTab: tab.kind === "file" || tab.kind === "artifact" || tab.kind === "preview" ? (tab.kind === "preview" ? "preview" : "files") : (tab.kind as DesktopLayoutState["activeTab"]),
      openTabIds: merged.openTabIds,
      previewUrl: tab.url ?? layout.previewUrl,
      expandedPreview: false,
    });
  }

  async function openBrowserSurface(kind: "browser" | "preview", url?: string) {
    const api = window.orvyn.browser;
    const existing = url
      ? browserState.tabs.find((t) => urlsMatch(t.url, url))
      : browserState.tabs.find((t) => t.kind === kind && !t.url) ?? browserState.tabs.find((t) => t.kind === kind);
    let state = browserState;
    if (api) {
      state = existing
        ? await api.activate(existing.id)
        : await api.create(kind, url);
      setBrowserState(state);
    }
    const native = state.tabs.find((t) => t.id === state.activeId) ?? existing ?? state.tabs[0];
    const pageUrl = native?.url || url;
    const previewTarget = kind === "preview" || (pageUrl && previewUrl && urlsMatch(pageUrl, previewUrl));
    const tab: WorkbenchTab = previewTarget && pageUrl
      ? parseWorkbenchTab(previewTabId(pageUrl))
      : native && native.kind !== "preview"
        ? { id: `browser:${native.id}`, kind: "browser", title: native.title || "Browser", fullTitle: native.title || native.url, closable: true, url: native.url, nativeId: native.id }
        : pageUrl && kind === "preview"
          ? parseWorkbenchTab(previewTabId(pageUrl))
          : parseWorkbenchTab(kind);
    activate(tab, true);
  }

  function close(id: string) {
    const tab = tabs.find((t) => t.id === id) ?? parseWorkbenchTab(id);
    const effect = workbenchTabCloseEffect(tab);
    if (effect.closeNativeView) {
      const native = matchingNativeTab(browserState, tab);
      if (native && native.kind !== "preview") void window.orvyn.browser?.close(native.id).then(setBrowserState);
    }
    const next = closeTab(tabs, id, activeId);
    const neighbor = next.tabs.find((t) => t.id === next.activeId);
    onLayout({
      openTabIds: next.tabs.map((t) => t.id),
      activeTabId: next.activeId,
      activeTab: neighbor
        ? neighbor.kind === "file" || neighbor.kind === "artifact" ? "files" : neighbor.kind === "preview" ? "preview" : (neighbor.kind as DesktopLayoutState["activeTab"])
        : layout.activeTab,
    });
  }

  const width = layout.expandedPreview
    ? Math.max(AGENT_PANEL_MIN, viewportWidth - SIDEBAR_WIDTH - 24)
    : clampAgentPanelWidth(layout.agentPanelWidth, viewportWidth);
  const followActive = follow.followOrion && !follow.paused;

  return (
    <div
      className="orvyn-agent-workbench"
      data-testid={WORKBENCH_TEST_ID}
      data-right-columns={countRightColumns({ rightPanelOpen: true })}
      data-active-tab={activeId}
      data-follow-state={follow.paused ? "paused" : followActive ? "on" : "off"}
      style={{
        display: "flex",
        height: "100%",
        width: overlay ? width : "100%",
        minWidth: 0,
        maxWidth: "100%",
        minHeight: 0,
        position: overlay ? "absolute" : "relative",
        top: overlay ? 0 : undefined,
        right: overlay ? 0 : undefined,
        bottom: overlay ? 0 : undefined,
        zIndex: overlay ? WORKBENCH_Z.tabbar : WORKBENCH_Z.content,
        background: "var(--orvyn-surface-1)",
        borderLeft: "1px solid var(--orvyn-border-soft)",
      }}
    >
      <div
        onMouseDown={(e) => {
          start.current = { x: e.clientX, width: layout.agentPanelWidth };
          setDragging(true);
        }}
        title="Drag to resize Workbench"
        style={splitHandle(dragging)}
      />
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div
          data-testid="workbench-header"
          className="wb-tabrow"
          style={{ zIndex: WORKBENCH_Z.tabbar }}
        >
          <div data-testid={WORKBENCH_TABBAR_TEST_ID} className="wb-tabs" title={headerLabel}>
            {tabs.map((t) => {
              const native = matchingNativeTab(browserState, t);
              const selected = t.id === activeId;
              const face = tabFace(t);
              const showClose = true;
              return (
                <button
                  key={t.id}
                  data-tab={t.id}
                  data-kind={t.kind}
                  data-active={selected ? "true" : "false"}
                  data-closable={showClose ? "true" : "false"}
                  className="wb-tab"
                  title={t.url || t.fullTitle || t.title}
                  onClick={() => activate(t, true)}
                  onAuxClick={(e) => {
                    if (e.button === 1 && showClose) close(t.id);
                  }}
                >
                  <TabGlyph tab={t} favicon={native?.favicon} loading={native?.loading} desktopLive={desktopLive} />
                  <span className="wb-tab-label">{face.text}</span>
                  {face.port && <span className="wb-port" data-testid="preview-port">{face.port}</span>}
                  {t.kind === "preview" && previewVersion > 0 && !face.port && (
                    <span className="wb-livedot" data-testid="preview-live" title="Live" />
                  )}
                  {showClose && (
                    <span
                      className="wb-tab-close"
                      data-tab-close={t.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        close(t.id);
                      }}
                    >
                      ×
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <button
            ref={plusBtnRef}
            data-testid="workbench-plus"
            className="wb-icon wb-plus"
            data-active={plusOpen ? "true" : "false"}
            title="Open tool"
            onClick={() => {
              setPlusOpen((v) => !v);
              setPortsOpen(false);
              plusQuery.setQuery("");
            }}
          >
            <IconPlus size={15} />
          </button>
          <WorkbenchPopover open={plusOpen} anchor={plusBtnRef.current} onClose={() => setPlusOpen(false)} testId="workbench-plus-menu" width={280}>
            <WorkbenchPlusMenu
              query={plusQuery.query}
              onQuery={plusQuery.setQuery}
              onSelect={(id, kind) => {
                setPlusOpen(false);
                if (kind === "subscriptions" || kind === "side-chat") return;
                if (kind === "browser") void openBrowserSurface("browser");
                else if (kind === "terminal" && tabs.some((t) => t.kind === "terminal")) {
                  const next = parseWorkbenchTab(nextTerminalTabId(tabs));
                  next.title = terminalTitle(environment, tabs.filter((t) => t.kind === "terminal").length + 1);
                  activate(next, true);
                } else activate(parseWorkbenchTab(id), true);
              }}
            />
          </WorkbenchPopover>
          <span data-testid="workbench-status" className="wb-tabtools" title={workspaceChromeStatus(environment)}>
            <button
              ref={portsBtnRef}
              data-testid="workbench-ports-btn"
              className="wb-icon"
              data-active={portsOpen ? "true" : "false"}
              title="Ports"
              onClick={() => { setPortsOpen((v) => !v); setPlusOpen(false); }}
            >
              <IconPlug size={15} />
            </button>
            <button
              data-testid="workbench-follow"
              className="wb-icon"
              data-active={followActive || follow.paused ? "true" : "false"}
              title={follow.paused ? "Resume Follow ORION" : "Follow ORION"}
              style={{ opacity: follow.paused ? 0.5 : 1 }}
              onClick={() => {
                const next = follow.paused ? resumeFollow() : toggleFollow(follow);
                setFollow(next);
                onLayout({ followOrion: next.followOrion });
              }}
            >
              <IconCrosshair size={15} />
            </button>
            <WorkbenchPopover
              open={portsOpen}
              anchor={portsBtnRef.current}
              onClose={() => setPortsOpen(false)}
              align="right"
              width={340}
              testId="workbench-ports"
            >
              <PortsPanel
                ports={ports.ports}
                autoForward={ports.autoForward}
                environment={environmentLabel(environment)}
                onAutoForward={ports.setAutoForward}
                onOpen={(p) => {
                  const url = p.previewUrl || p.localUrl;
                  if (url) void openBrowserSurface("preview", url);
                  setPortsOpen(false);
                }}
                onStop={(id) => void ports.stop(id)}
                onClose={() => setPortsOpen(false)}
              />
            </WorkbenchPopover>
            <button
              className="wb-icon"
              data-active={layout.expandedPreview ? "true" : "false"}
              title="Expand Workbench"
              onClick={() => onLayout({ expandedPreview: !layout.expandedPreview })}
            >
              <IconExpand size={15} />
            </button>
            <button
              data-testid="workbench-close"
              className="wb-icon"
              title="Close panel"
              onClick={() => {
                void window.orvyn.browser?.setVisible(false);
                onLayout({ rightPanelOpen: false });
              }}
            >
              <IconClose size={15} />
            </button>
          </span>
        </div>
        <div style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden", display: "flex", position: "relative", zIndex: WORKBENCH_Z.content }}>
          {emptyWorkbench && (
            <WorkbenchLauncher onOpen={(id) => {
              if (id === "browser") void openBrowserSurface("browser");
              else activate(parseWorkbenchTab(id), true);
            }} />
          )}
          <div style={{ display: browserish ? "flex" : "none", flex: 1, minHeight: 0, minWidth: 0 }}>
            <BrowserWorkbench
              kind={active?.kind === "preview" ? "preview" : "browser"}
              projectName={headerLabel}
              orionStatus={derived.activity?.tab === "browser" || derived.activity?.tab === "preview" ? derived.activity.line : null}
              requestedUrl={active?.url}
              liveVersion={previewVersion}
              updating={running && active?.kind === "preview"}
              previewStopped={surface.previewStopped && !active?.url}
              preparing={previewPreparing && !previewUrl}
              buildFiles={derived.files.filter((file) => file.kind !== "read").map((file) => file.path)}
              sessionId={activeNative?.id}
              surfaceActive={browserish && !plusOpen && !portsOpen}
              onTabs={setBrowserState}
              addressFocusToken={addressFocus}
            />
          </div>
          {tabs.some((t) => t.kind === "desktop") && (
            <div style={{ display: active?.kind === "desktop" ? "flex" : "none", flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden" }}>
              <DesktopView
                active={active?.kind === "desktop"}
                // The Desktop is a whole Linux computer, not a project view: it starts
                // with the conversation's workspace, the open project, or on its own.
                projectRoot={boundRoot || projectRoot || "desktop"}
                runId={runId}
                cursor={derived.browser.cursor}
                status={derived.activity?.tab === "desktop" ? derived.activity.line : null}
              />
            </div>
          )}
          {!emptyWorkbench && !browserish && active?.kind !== "desktop" && active && (
            <WorkbenchBody
              tab={active}
              derived={derived}
              events={events}
              review={review}
              runStatus={runStatus}
              runId={runId}
              projectRoot={boundRoot}
              surface={surface}
              listDisk={listDisk}
              environment={environment}
              ports={ports.ports}
              filesFocus={filesFocus}
              onOpenDiff={(path) => activate(parseWorkbenchTab(diffTabId(path)), true)}
              onOpenFile={(path) => {
                if (isFabricatedGeneratedPath(path)) {
                  setFilesFocus({ path, fileName: path.replace(/\\/g, "/").split("/").pop(), user: true });
                  activate(parseWorkbenchTab("files"), true);
                  return;
                }
                onOpenFile(path);
                activate(parseWorkbenchTab(fileTabId(path)), true);
              }}
              onOpenArtifact={(name, artifactId) => {
                if (artifactId) activate(parseWorkbenchTab(artifactTabId(name, artifactId)), true);
                else {
                  setFilesFocus({ fileName: name, user: true });
                  activate(parseWorkbenchTab("files"), true);
                }
              }}
              onOpenTab={(id) => activate(parseWorkbenchTab(id), true)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

const TAB_ICONS: Partial<Record<WorkbenchTabKind, React.ComponentType<{ size?: number }>>> = {
  changes: IconGit,
  files: IconFolder,
  file: IconFile,
  diff: IconGit,
  terminal: IconTerminal,
  browser: IconGlobe,
  preview: IconGlobe,
  desktop: IconMonitor,
  environment: IconServer,
  artifact: IconImage,
  review: IconCheck,
  plan: IconList,
  docs: IconFile,
};

function TabGlyph({
  tab,
  favicon,
  loading,
  desktopLive,
}: {
  tab: WorkbenchTab;
  favicon?: string;
  loading?: boolean;
  desktopLive: boolean;
}) {
  if ((tab.kind === "browser" || tab.kind === "preview") && favicon) {
    return <img src={favicon} alt="" width={13} height={13} style={{ flexShrink: 0, borderRadius: 2 }} />;
  }
  const Icon = TAB_ICONS[tab.kind] ?? IconFile;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", flexShrink: 0, position: "relative" }}>
      <Icon size={15} />
      {tab.kind === "desktop" && desktopLive && (
        <span title="Desktop live" style={{ position: "absolute", top: -2, right: -3, width: 5, height: 5, borderRadius: 99, background: "var(--orvyn-cyan)" }} />
      )}
      {loading && (
        <span title="Loading" style={{ position: "absolute", top: -2, right: -3, width: 5, height: 5, borderRadius: 99, background: "var(--orvyn-cyan)" }} />
      )}
    </span>
  );
}

function tabFace(tab: WorkbenchTab): { text: string; port: string | null } {
  if (tab.kind === "preview" || (tab.kind === "browser" && tab.url)) return previewFace(tab);
  return { text: tab.title, port: null };
}

function previewFace(tab: WorkbenchTab): { text: string; port: string | null } {
  let port: string | null = null;
  if (tab.url) {
    try {
      const u = new URL(tab.url);
      if (u.port) port = `:${u.port}`;
    } catch {
      port = null;
    }
  }
  const candidate = tab.fullTitle && !/^https?:\/\//i.test(tab.fullTitle) ? tab.fullTitle : tab.title;
  const stripped = candidate.replace(/\s+:\d+$/, "").trim();
  const generic = !stripped || stripped === "Preview" || /^ORVYN\b/i.test(stripped);
  const text = generic ? "Preview" : stripped.length > 22 ? `${stripped.slice(0, 21)}…` : stripped;
  return { text, port };
}

function RestoreStrip({ surface }: { surface: WorkbenchSurface }) {
  if (!surface.projectStatusLabel && !surface.previewStatusLabel && surface.runs.length === 0) return null;
  const newest = [...surface.runs].reverse().find((run) => run.instruction);
  return (
    <div data-testid="workbench-restore" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", padding: "8px 12px", borderBottom: "1px solid var(--orvyn-border-soft)", fontSize: 12, color: "var(--orvyn-text-secondary)" }}>
      {surface.projectName && <strong style={{ color: "var(--orvyn-text)" }}>{surface.projectName}</strong>}
      {surface.projectStatusLabel && <span data-testid="project-restored">{surface.projectStatusLabel}</span>}
      {surface.previewStatusLabel && <span data-testid="preview-status">{surface.previewStatusLabel}</span>}
      {surface.runs.length > 0 && <span>{surface.runs.length === 1 ? "1 run" : `${surface.runs.length} runs`}</span>}
      {newest?.instruction && <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{newest.instruction}</span>}
    </div>
  );
}

function matchingNativeTab(state: WorkbenchBrowserState, tab: WorkbenchTab) {
  if (tab.nativeId) {
    const byNative = state.tabs.find((t) => t.id === tab.nativeId);
    if (byNative) return byNative;
  }
  if (tab.id.startsWith("browser:")) return state.tabs.find((t) => t.id === tab.id.slice("browser:".length));
  if (tab.url) return state.tabs.find((t) => urlsMatch(t.url, tab.url));
  if (tab.id === "browser") return state.tabs.find((t) => t.kind === "browser" && !t.url) ?? state.tabs.find((t) => t.kind === "browser");
  return undefined;
}

function WorkbenchBody({
  tab,
  derived,
  events,
  review,
  runStatus,
  runId,
  projectRoot,
  surface,
  listDisk,
  environment,
  ports,
  filesFocus,
  onOpenDiff,
  onOpenFile,
  onOpenArtifact,
  onOpenTab,
}: {
  tab: WorkbenchTab;
  derived: ReturnType<typeof deriveAgentWorkspace>;
  events: AgentEvent[];
  review: ReturnType<typeof deriveReviewSummary>;
  runStatus: string;
  runId?: string | null;
  projectRoot: string | null;
  surface: WorkbenchSurface;
  listDisk: boolean;
  environment: ReturnType<typeof resolveWorkbenchEnvironment>;
  ports: { port: number; command?: string; status: string }[];
  filesFocus?: { path?: string; fileName?: string; artifactId?: string; user?: boolean } | null;
  onOpenDiff: (path: string) => void;
  onOpenFile: (path: string) => void;
  onOpenArtifact: (name: string, artifactId?: string) => void;
  onOpenTab: (id: string) => void;
}) {
  if (tab.kind === "changes") {
    return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, minWidth: 0, width: "100%" }}>
      <RestoreStrip surface={surface} />
      <ChangesView
        files={surface.changeFiles}
        diffs={surface.changes}
        summary={surface.summary}
        selected={tab.path ?? derived.activity?.file}
        onSelect={() => { /* stay on Changes; the split shows the diff */ }}
      />
      </div>
    );
  }
  if (tab.kind === "files") {
    const artifacts = [
      ...derived.artifacts,
      ...surface.artifacts
        .filter((item) => !derived.artifacts.some((have) => have.artifactId === item.artifactId))
        .map((item) => ({ path: item.name || item.artifactId, kind: "artifact" as const, artifactId: item.artifactId, mimeType: item.mimeType })),
    ];
    return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, minWidth: 0, width: "100%" }}>
      <RestoreStrip surface={surface} />
      <FilesInspector
        files={surface.changeFiles}
        artifacts={artifacts}
        // The workspace this conversation is bound to (a Cloud workspace has a
        // server path the Electron folder never equals); the local folder only
        // when it IS that workspace.
        projectRoot={listDisk ? projectRoot : (surface.listRoot ?? projectRoot)}
        workspaceStatus={surface.status}
        writtenPaths={surface.files.map((f) => f.path)}
        listDisk={listDisk}
        sessionId={String([...events].reverse().find((e) => e.type === "run.session")?.data?.sessionId ?? "") || null}
        environment={environment}
        focus={filesFocus}
        activePath={derived.activity?.file}
        onOpenFile={onOpenFile}
        onPreviewArtifact={onOpenArtifact}
        onOpenChanges={onOpenDiff}
      />
      </div>
    );
  }
  if (tab.kind === "diff") {
    return (
      <DiffInspector diffs={surface.changes} selectedPath={tab.path ?? derived.activity?.file} onSelect={onOpenDiff} />
    );
  }
  if (tab.kind === "file") return <FileEditorView path={tab.path} />;
  if (tab.kind === "terminal") return <TerminalInspector events={events} environment={environment} environmentLabel={tab.title.startsWith("Terminal") ? tab.title : terminalTitle(environment)} />;
  if (tab.kind === "environment") {
    return <EnvironmentView environment={environment} projectRoot={projectRoot} runId={runId} ports={ports} />;
  }
  if (tab.kind === "review") {
    return (
      <ReviewInspector
        runId={runId ?? undefined}
        summary={review}
        onOpenDiff={() => onOpenTab("changes")}
        onOpenTerminal={() => onOpenTab("terminal")}
        onOpenArtifact={() => onOpenTab("files")}
      />
    );
  }
  if (tab.kind === "artifact") {
    const art = derived.artifacts.find((a) => (tab.artifactId && a.artifactId === tab.artifactId) || a.path === tab.path);
    return <ArtifactView name={art?.path ?? tab.path ?? tab.title} artifactId={tab.artifactId ?? art?.artifactId} />;
  }
  if (tab.kind === "plan") {
    return (
      <div style={{ flex: 1, overflow: "auto", padding: 10 }}>
        <MissionPlan events={events} status={runStatus} />
      </div>
    );
  }
  if (tab.kind === "docs") return <DocumentsPanel projectRoot={projectRoot} revision={derived.artifacts.length} />;
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 32, textAlign: "center", gap: 10 }}>
      <div style={{ fontSize: 16, fontWeight: 650 }}>ORVYN Workbench</div>
      <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)", maxWidth: 360, lineHeight: 1.6 }}>
        Files, previews, browser sessions, terminal output, and artifacts will appear here as ORION works.
      </div>
    </div>
  );
}
