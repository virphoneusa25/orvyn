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
  previewTitle,
  truncateTabTitle,
  upsertTab,
  WORKBENCH_TABBAR_TEST_ID,
  WORKBENCH_TEST_ID,
  type WorkbenchTab,
} from "../../workbenchModel";
import { isFabricatedGeneratedPath } from "../../workbenchFileAccess";
import { environmentLabel, resolveWorkbenchEnvironment, terminalTitle } from "../../workbenchEnvironment";
import { readComposerDefaults } from "../../composerSettings";
import { isCloudBackend, getConnectionConfig } from "../../connection";
import { DocumentsPanel } from "../DocumentsPanel";
import { MissionPlan } from "../MissionPlan";
import { IconClose, IconCrosshair, IconExpand, IconGlobe, IconLayout, IconPlug, IconPlus } from "../Icons";
import type { WorkbenchBrowserState } from "../../orvyn-bridge";
import { AgentActivityHeader } from "./AgentActivityHeader";
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
import { iconBtn, splitHandle, tabBtn } from "./workspaceChrome";

export function AgentWorkspacePanel(props: Parameters<typeof AgentWorkspace>[0]) {
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
  const derived = useMemo(() => deriveAgentWorkspace(events, { projectName }), [events, projectName]);
  const review = useMemo(() => deriveReviewSummary(events, derived), [events, derived]);
  const running = runStatus === "running" || runStatus === "streaming" || runStatus === "working";
  const [follow, setFollow] = useState<FollowController>(() => initialFollowState(running && layout.followOrion !== false));
  const [plusOpen, setPlusOpen] = useState(false);
  const [portsOpen, setPortsOpen] = useState(false);
  const [filesFocus, setFilesFocus] = useState<{ path?: string; fileName?: string; artifactId?: string } | null>(null);
  const plusQuery = usePlusQuery();
  const plusBtnRef = useRef<HTMLButtonElement | null>(null);
  const portsBtnRef = useRef<HTMLButtonElement | null>(null);
  const [browserState, setBrowserState] = useState<WorkbenchBrowserState>({ tabs: [], recents: [], activeId: null });
  const [addressFocus, setAddressFocus] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1440));
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, width: layout.agentPanelWidth });
  const previewSeeded = useRef(new Set<string>());
  const desktopLive = events.some((e) => String(e.type).startsWith("desktop.") && e.type !== "desktop.completed" && e.type !== "desktop.failed");

  const executionActual = [...events].reverse().find((e) => e.type === "run.execution")?.data?.executionTargetActual
    ?? [...events].reverse().find((e) => e.type === "run.execution")?.data?.executionTargetRequested;
  const environment = resolveWorkbenchEnvironment({
    executionActual: executionActual != null ? String(executionActual) : undefined,
    executionTarget: readComposerDefaults().executionTarget,
    cloudBackend: isCloudBackend(getConnectionConfig().backendUrl),
  });
  const eventText = events.map((e) => String(e.data?.output ?? e.data?.preview ?? e.data?.chunk ?? "")).join("\n");
  const ports = useWorkbenchPorts({ environment, runId, projectRoot, eventText });

  const tabs = useMemo(() => {
    const ids = layout.openTabIds;
    let list = ids.map(parseWorkbenchTab);

    const nativeBrowser = browserState.tabs.filter((t) => t.kind === "browser");
    if (nativeBrowser.length) {
      list = list.filter((t) => t.id !== "browser");
      for (const t of nativeBrowser) {
        list = upsertTab(list, {
          id: `browser:${t.id}`,
          kind: "browser",
          title: t.url ? truncateTabTitle(t.title || t.url) : "Browser",
          closable: true,
          url: t.url,
        });
      }
    }

    for (const t of browserState.tabs.filter((x) => x.kind === "preview")) {
      const url = t.url;
      list = upsertTab(list, {
        id: url ? previewTabId(url) : `browser:${t.id}`,
        kind: "preview",
        title: truncateTabTitle(t.title || (url ? previewTitle(url, projectName) : "Preview")),
        closable: true,
        url,
      });
    }
    for (const p of derived.previews) {
      list = upsertTab(list, parseWorkbenchTab(previewTabId(p.url)));
    }
    return list;
  }, [layout.openTabIds, derived.previews, desktopLive, browserState.tabs, projectName]);

  const activeId = tabs.some((t) => t.id === layout.activeTabId) ? layout.activeTabId : tabs[0]?.id ?? "";
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
    for (const p of derived.previews) {
      if (previewSeeded.current.has(p.url)) continue;
      if (browserState.tabs.some((t) => urlsMatch(t.url, p.url))) {
        previewSeeded.current.add(p.url);
        continue;
      }
      previewSeeded.current.add(p.url);
      void api.create("preview", p.url).then(setBrowserState);
    }
  }, [derived.previews, browserState.tabs]);

  useEffect(() => {
    if (!followApplies(follow)) return;
    const activity = derived.activity;
    if (!activity || activity.switchTab === false) return;
    const currentKind: AgentWorkspaceTab =
      !active ? "changes" : active.kind === "file" || active.kind === "artifact" ? "files" : (active.kind as AgentWorkspaceTab);
    const nextKind = followActiveTab(activity, currentKind);
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
      setFilesFocus({ path: activity.file, fileName: activity.file, artifactId: activity.artifactId });
    }
    if (next.id === activeId) return;
    onLayout({
      activeTabId: next.id,
      activeTab: next.kind === "file" || next.kind === "artifact" ? "files" : (next.kind as DesktopLayoutState["activeTab"]),
      openTabIds: upsertTab(tabs, next).map((t) => t.id),
      previewUrl: next.url ?? layout.previewUrl,
    });
  }, [derived.activity, follow, activeId, browserState.tabs, browserState.activeId]);

  useEffect(() => {
    const open = (e: Event) => {
      const d = (e as CustomEvent<{ tab?: string; path?: string; url?: string; fileName?: string; artifactId?: string }>).detail;
      const mapped = mapContextTab(d?.tab);
      setFollow((s) => applyManualTab(s));
      if (mapped === "files") {
        setFilesFocus({ path: d?.path, fileName: d?.fileName, artifactId: d?.artifactId });
        activate(parseWorkbenchTab("files"), true);
        return;
      }
      if (d?.path && mapped === "diff") {
        activate(parseWorkbenchTab(diffTabId(d.path)), true);
        return;
      }
      if (mapped === "browser" || mapped === "preview") {
        void openBrowserSurface(mapped, d?.url ?? derived.activity?.previewUrl);
        return;
      }
      if (mapped) activate(parseWorkbenchTab(mapped), true);
    };
    document.addEventListener("orvyn:context-open", open);
    document.addEventListener("orvyn:context-tab", open);
    return () => {
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
      if (tab.id === "browser" && !browserState.tabs.some((t) => t.kind === "browser")) {
      void openBrowserSurface("browser");
      return;
    }
    onLayout({
      rightPanelOpen: true,
      activeTabId: tab.id,
      activeTab: tab.kind === "file" || tab.kind === "artifact" || tab.kind === "preview" ? (tab.kind === "preview" ? "preview" : "files") : (tab.kind as DesktopLayoutState["activeTab"]),
      openTabIds: upsertTab(tabs, tab).map((t) => t.id),
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
    const tab: WorkbenchTab = native?.kind === "preview" && native.url
      ? { id: previewTabId(native.url), kind: "preview", title: native.title || previewTitle(native.url, projectName), closable: true, url: native.url }
      : native
        ? { id: `browser:${native.id}`, kind: "browser", title: native.title || "Browser", closable: true, url: native.url }
        : parseWorkbenchTab(kind);
    activate(tab, true);
  }

  function close(id: string) {
    const native = matchingNativeTab(browserState, tabs.find((t) => t.id === id) ?? parseWorkbenchTab(id));
    if (native) void window.orvyn.browser?.close(native.id).then(setBrowserState);
    const next = closeTab(tabs, id, activeId);
    onLayout({ openTabIds: next.tabs.map((t) => t.id), activeTabId: next.activeId });
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
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div data-testid={WORKBENCH_TABBAR_TEST_ID} style={{ display: "flex", alignItems: "center", height: 36, borderBottom: "1px solid var(--orvyn-border-soft)", padding: "0 4px", minWidth: 0, position: "relative", zIndex: WORKBENCH_Z.tabbar }}>
          <div style={{ display: "flex", alignItems: "center", overflowX: "auto", flex: 1, minWidth: 0 }}>
            <button
              ref={plusBtnRef}
              data-testid="workbench-plus"
              title="Open Workbench tool"
              style={iconBtn(plusOpen)}
              onClick={() => {
                setPlusOpen((v) => !v);
                setPortsOpen(false);
                plusQuery.setQuery("");
              }}
            >
              <IconPlus size={13} />
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
            {tabs.map((t) => {
              const native = matchingNativeTab(browserState, t);
              return (
                <button
                  key={t.id}
                  data-tab={t.id}
                  onClick={() => activate(t, true)}
                  onAuxClick={(e) => {
                    if (e.button === 1 && t.closable) close(t.id);
                  }}
                  style={{ ...tabBtn(t.id === activeId), height: 36, padding: "0 12px" }}
                >
                  {t.kind === "desktop" && desktopLive && (
                    <span title="Desktop live" style={{ width: 6, height: 6, borderRadius: 99, background: "var(--orvyn-cyan)", marginRight: 6, display: "inline-block" }} />
                  )}
                  {(t.kind === "browser" || t.kind === "preview") && (
                    <span style={{ marginRight: 6, display: "inline-flex", alignItems: "center" }}>
                      {native?.favicon ? <img src={native.favicon} alt="" width={12} height={12} /> : <IconGlobe size={12} />}
                      {native?.loading && (
                        <span title="Loading" style={{ width: 6, height: 6, borderRadius: 99, background: "var(--orvyn-cyan)", marginLeft: 4, display: "inline-block" }} />
                      )}
                    </span>
                  )}
                  {t.title}
                  {t.closable && (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        close(t.id);
                      }}
                      style={{ marginLeft: 6, opacity: 0.65 }}
                    >
                      ×
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
            {follow.paused && follow.followOrion && <span style={{ fontSize: 10, color: "var(--orvyn-yellow)" }}>Follow paused</span>}
            <button title={follow.paused ? "Resume following ORION" : "Follow ORION"} style={iconBtn(followActive)} onClick={() => {
              const next = follow.paused ? resumeFollow() : toggleFollow(follow);
              setFollow(next);
              onLayout({ followOrion: next.followOrion });
            }}>
              <IconCrosshair size={14} />
            </button>
            <button
              ref={portsBtnRef}
              data-testid="workbench-ports-btn"
              title="Ports and previews"
              style={iconBtn(portsOpen)}
              onClick={() => { setPortsOpen((v) => !v); setPlusOpen(false); }}
            >
              <IconPlug size={14} />
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
            <button title="Maximize Workbench" style={iconBtn(layout.expandedPreview)} onClick={() => onLayout({ expandedPreview: !layout.expandedPreview })}>
              <IconExpand size={14} />
            </button>
            <button title="Workbench layout" style={iconBtn()} onClick={() => onLayout({ agentPanelWidth: layout.agentPanelWidth >= 780 ? 520 : 780 })}>
              <IconLayout size={14} />
            </button>
            <button title="Close Workbench" style={iconBtn()} onClick={() => {
              void window.orvyn.browser?.setVisible(false);
              onLayout({ rightPanelOpen: false });
            }}>
              <IconClose size={13} />
            </button>
          </span>
        </div>
        <AgentActivityHeader line={derived.activity?.line} running={running} waitingApproval={derived.waitingApproval} />
        <div style={{ flex: 1, minHeight: 0, display: "flex", position: "relative", zIndex: WORKBENCH_Z.content }}>
          {emptyWorkbench && (
            <WorkbenchLauncher onOpen={(id) => {
              if (id === "browser") void openBrowserSurface("browser");
              else activate(parseWorkbenchTab(id), true);
            }} />
          )}
          <div style={{ display: browserish ? "flex" : "none", flex: 1, minHeight: 0, minWidth: 0 }}>
            <BrowserWorkbench
              kind={active?.kind === "preview" ? "preview" : "browser"}
              projectName={projectName}
              orionStatus={derived.activity?.tab === "browser" || derived.activity?.tab === "preview" ? derived.activity.line : null}
              requestedUrl={active?.url}
              sessionId={activeNative?.id}
              surfaceActive={browserish && !plusOpen && !portsOpen}
              onTabs={setBrowserState}
              addressFocusToken={addressFocus}
            />
          </div>
          {tabs.some((t) => t.kind === "desktop") && (
            <div style={{ display: active?.kind === "desktop" ? "flex" : "none", flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden" }}>
              <DesktopView
                projectRoot={projectRoot}
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
              projectRoot={projectRoot}
              environment={environment}
              ports={ports.ports}
              filesFocus={filesFocus}
              onOpenDiff={(path) => activate(parseWorkbenchTab(diffTabId(path)), true)}
              onOpenFile={(path) => {
                if (isFabricatedGeneratedPath(path)) {
                  setFilesFocus({ path, fileName: path.replace(/\\/g, "/").split("/").pop() });
                  activate(parseWorkbenchTab("files"), true);
                  return;
                }
                onOpenFile(path);
                activate(parseWorkbenchTab(fileTabId(path)), true);
              }}
              onOpenArtifact={(name, artifactId) => {
                if (artifactId) activate(parseWorkbenchTab(artifactTabId(name, artifactId)), true);
                else {
                  setFilesFocus({ fileName: name });
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

function matchingNativeTab(state: WorkbenchBrowserState, tab: WorkbenchTab) {
  if (tab.id.startsWith("browser:")) return state.tabs.find((t) => t.id === tab.id.slice("browser:".length));
  if (tab.kind === "preview" && tab.url) return state.tabs.find((t) => t.kind === "preview" && urlsMatch(t.url, tab.url!));
  if (tab.id === "browser") return state.tabs.find((t) => t.kind === "browser" && !t.url) ?? state.tabs.find((t) => t.kind === "browser");
  return undefined;
}

function urlsMatch(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const norm = (u: string) => u.replace(/\/$/, "");
  return norm(a) === norm(b);
}

function WorkbenchBody({
  tab,
  derived,
  events,
  review,
  runStatus,
  runId,
  projectRoot,
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
  environment: ReturnType<typeof resolveWorkbenchEnvironment>;
  ports: { port: number; command?: string; status: string }[];
  filesFocus?: { path?: string; fileName?: string; artifactId?: string } | null;
  onOpenDiff: (path: string) => void;
  onOpenFile: (path: string) => void;
  onOpenArtifact: (name: string, artifactId?: string) => void;
  onOpenTab: (id: string) => void;
}) {
  if (tab.kind === "changes") {
    return (
      <ChangesView
        files={derived.files}
        diffs={derived.diffs}
        summary={derived.changeSummary}
        selected={tab.path ?? derived.activity?.file}
        onSelect={() => { /* stay on Changes; the split shows the diff */ }}
      />
    );
  }
  if (tab.kind === "files") {
    return (
      <FilesInspector
        files={derived.files}
        artifacts={derived.artifacts}
        projectRoot={projectRoot}
        environment={environment}
        focus={filesFocus}
        activePath={derived.activity?.file}
        onOpenFile={onOpenFile}
        onPreviewArtifact={onOpenArtifact}
      />
    );
  }
  if (tab.kind === "diff") {
    return (
      <DiffInspector diffs={derived.diffs} selectedPath={tab.path ?? derived.activity?.file} onSelect={onOpenDiff} />
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

