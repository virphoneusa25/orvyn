import React, { useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import appIcon from "./assets/icon.png";
import { FileExplorer } from "./components/FileExplorer";
import { AIChatPanel } from "./components/AIChatPanel";
import { ModelManager } from "./components/ModelManager";
import { ChatsWorkspace } from "./components/ChatsWorkspace";
import { MemoryPanel } from "./components/MemoryPanel";
import { ReportsPanel } from "./components/ReportsPanel";
import { ComposerPanel } from "./components/ComposerPanel";
import { AgentPanel } from "./components/AgentPanel";
import { SearchPanel } from "./components/SearchPanel";
import { ConnectionSettings } from "./components/ConnectionSettings";
import { ViewId } from "./components/Navigation";
import { Sidebar } from "./components/redesign/Shell";
import { submitOrvynCommand } from "./orvynCommand";
import { WorkStream } from "./components/WorkStream";
import { ContextPanel } from "./components/ContextPanel";
import { useAgentRun } from "./useAgentRun";
import { HomeScreen } from "./components/redesign/HomeScreen";
import { MissionDetail } from "./components/redesign/MissionDetail";
import { missionDetailFromRuntime, type ApiMissionDetail } from "./components/redesign/runtimeAdapter";
import { toMissionSummary, toSystems, ApiMissionRow } from "./components/redesign/adapters";
import type { MissionSummary } from "./components/redesign/types";
import { StatusBar } from "./components/StatusBar";
import { HonestState } from "./components/HonestState";
import { AgentsWorkspace, ProjectsWorkspace, ServersWorkspace } from "./components/Workspaces";
import { ToolsMcpWorkspace } from "./components/ToolsMcpWorkspace";
import { EditorTabs } from "./components/EditorTabs";
import { loadConnectionConfig, apiUrl, authHeaders, noteProtectedStatus } from "./connection";
import { describeConnection, heroStatusLine } from "./connectionState";
import { getConnectionFacts, noteLocalEngine, noteWorkspaceName, onConnectionFacts, startConnectionRuntime } from "./connectionRuntime";
import { WorkspaceState } from "./orvyn-bridge";
import { newChat, openChatSession, initChatHistory } from "./chatSession";
import { pickReattachRun } from "./appReattach";
import { useInlineEdit } from "./useInlineEdit";
import { InlineEdit } from "./components/InlineEdit";
import { CommandPalette, PaletteCommand, PaletteMode } from "./components/CommandPalette";
import { registerTabAutocomplete } from "./tabComplete";
import { TitleBar, Menu } from "./components/TitleBar";
import { ResizablePanel } from "./components/ResizablePanel";
import { MissionControl } from "./components/MissionControl";
import { ReviewPanel } from "./components/ReviewPanel";
import { BottomPanel } from "./components/BottomPanel";
import { GitScmPanel } from "./components/GitScmPanel";


interface OpenFile {
  path: string;
  content: string;
  dirty?: boolean;
}

function guessLanguage(path: string): string {
  const base = (path.split(/[\\/]/).pop() ?? path).toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  if (base === ".htaccess" || base === "htaccess" || base.startsWith(".htaccess")) return "ini";
  if (base === "makefile" || base === "gnumakefile") return "plaintext";
  const ext = base.includes(".") ? (base.split(".").pop() ?? "") : "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    md: "markdown",
    markdown: "markdown",
    py: "python",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    less: "less",
    php: "php",
    phtml: "php",
    xml: "xml",
    svg: "xml",
    ini: "ini",
    conf: "ini",
    sql: "sql",
    yml: "yaml",
    yaml: "yaml",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    ps1: "powershell",
    go: "go",
    rs: "rust",
    java: "java",
    rb: "ruby",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    hpp: "cpp",
    cs: "csharp",
    kt: "kotlin",
    swift: "swift",
    lua: "lua",
    r: "r",
    dockerfile: "dockerfile",
    twig: "html",
    vue: "html",
    txt: "plaintext",
  };
  return map[ext] ?? "plaintext";
}

export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [tabs, setTabs] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [view, setView] = useState<ViewId>("home");
  /** Center surface: the Home dashboard, or the active work conversation. */
  const [centerMode, setCenterMode] = useState<"home" | "work">("home");
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [projectFiles, setProjectFiles] = useState<string[]>([]);
  const [homeMissions, setHomeMissions] = useState<MissionSummary[]>([]);
  const [facts, setFacts] = useState(getConnectionFacts);
  const [runtimeCaps, setRuntimeCaps] = useState({ engineReady: false, dockerAvailable: false, sshHostCount: 0, githubConnected: false, postgresConnected: false, cloudSignedIn: false });
  const [missionDetail, setMissionDetail] = useState<ApiMissionDetail | null>(null);

  /** The run any entry point last started — ONE state, shared by center + right. */
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const autoOpenedRoot = useRef<string | null>(null);
  const indexedRoot = useRef<string | null>(null);

  const openFile = tabs.find((t) => t.path === activePath) ?? null;
  const workspaceRoot = workspace?.root ?? null;
  // Home is the landing surface; Code and Terminal share the editor chrome;
  // the context panel rides along wherever work happens.
  const showEditorChrome = view === "editor" || view === "terminal";
  // The approved Home has NO right panel — the dashboard owns the full
  // center. Context appears only once work begins (or in the editor).
  const showContext =
    view === "editor" ||
    view === "terminal" ||
    ((view === "home" || view === "newtask") && centerMode === "work");
  const inlineEdit = useInlineEdit(openFile?.path);
  // The single run view every surface derives from.
  const agentRun = useAgentRun(workspaceRoot, { attachRunId: activeRunId });

  const runView = {
    events: agentRun.events,
    status: agentRun.status,
    runId: agentRun.runId,
    approve: agentRun.approve,
    stop: agentRun.stop,
    lastEventAt: agentRun.lastEventAt,
    usage: agentRun.usage,
  };

  const projectName = workspaceRoot ? (workspaceRoot.split(/[\\/]/).pop() ?? null) : null;
  const presentation = describeConnection(facts);
  const cloudOnline = presentation.state === "cloud-online" || presentation.state === "cloud-synced";
  const heroLine = heroStatusLine(facts, homeMissions);

  useEffect(() => {
    const stop = startConnectionRuntime();
    const off = onConnectionFacts(setFacts);
    return () => {
      off();
      stop();
    };
  }, []);

  useEffect(() => {
    noteWorkspaceName(projectName);
  }, [projectName]);

  useEffect(() => {
    const suffix = workspaceRoot ? `?projectRoot=${encodeURIComponent(workspaceRoot)}` : "";
    const load = () => fetch(apiUrl(`/runtime/capabilities${suffix}`), { headers: authHeaders() }).then(r => {
      noteProtectedStatus(r.status, apiUrl(`/runtime/capabilities${suffix}`));
      return r.ok ? r.json() : Promise.reject();
    }).then((caps) => {
      setRuntimeCaps(caps);
      if (typeof caps.engineReady === "boolean") noteLocalEngine(caps.engineReady ? "ready" : "offline");
    }).catch(() => setRuntimeCaps(v => ({ ...v, dockerAvailable: false })));
    void load(); const t = setInterval(load, 10000); return () => clearInterval(t);
  }, [workspaceRoot]);

  useEffect(() => {
    if (!workspaceRoot) { setHomeMissions([]); return; }
    const load = () => fetch(apiUrl("/missions"), { headers: authHeaders() }).then(r => { noteProtectedStatus(r.status, apiUrl("/missions")); return r.ok ? r.json() : Promise.reject(); }).then(d => { const rows: ApiMissionRow[] = Array.isArray(d.missions) ? d.missions : []; setHomeMissions(rows.map(toMissionSummary)); }).catch(() => setHomeMissions([]));
    void load(); const t = setInterval(load, 5000); return () => clearInterval(t);
  }, [workspaceRoot]);

  // Restart reattachment: if the backend still has a run in flight (cloud or
  // local), reopen its Active Workspace after startup so a restart never
  // orphans live work. The attach path replays missed events by sequence.
  // Runs once per app launch, after the session/connection has settled.
  const reattachTried = useRef(false);
  useEffect(() => {
    if (reattachTried.current) return;
    const t = setTimeout(() => {
      reattachTried.current = true;
      fetch(apiUrl("/agent/stream/runs"), { headers: authHeaders() })
        .then((r) => (r.ok ? r.json() : { runs: [] }))
        .then((d) => {
          const reattach = pickReattachRun(d.runs ?? []);
          if (reattach) document.dispatchEvent(new CustomEvent("orvyn:open-run", { detail: reattach }));
        })
        .catch(() => { /* offline/local-only: nothing to reattach */ });
    }, 5000);
    return () => clearTimeout(t);
  }, []);

  // Home's "View All"/"Manage" links navigate via custom events.
  useEffect(() => {
    const onNav = (e: Event) => {
      const target = (e as CustomEvent<string>).detail as ViewId | undefined;
      if (target) setView(target);
    };
    document.addEventListener("orvyn:nav", onNav);
    // Recent Missions / Mission Control re-entry: reopen a mission's Active
    // Workspace with its run attached (conversation + activity restored).
    const onOpenRun = (e: Event) => {
      const runId = (e as CustomEvent<string>).detail;
      if (!runId) return;
      // The run carries its own conversation (instruction + streamed reply);
      // whatever chat thread was active must not bleed into this workspace.
      newChat();
      setActiveRunId(runId);
      setCenterMode("work");
      setView("newtask");
    };
    document.addEventListener("orvyn:open-run", onOpenRun);
    return () => {
      document.removeEventListener("orvyn:nav", onNav);
      document.removeEventListener("orvyn:open-run", onOpenRun);
    };
  }, []);

  useEffect(() => {
    const dispose = registerTabAutocomplete();
    loadConnectionConfig().then(() => window.orvyn.project.getWorkspace().then(setWorkspace));
    // Load persisted chat history — the Chats workspace and WorkStream share
    // these sessions. Non-blocking: the app renders immediately, chats
    // populate when the IPC load completes (initChatHistory emits).
    void initChatHistory();
    return () => dispose.dispose();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key.toLowerCase() !== "p") return;
      e.preventDefault();
      setPalette(e.shiftKey ? "commands" : "files");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!workspace?.root) return;
    window.orvyn.project.listFiles().then(setProjectFiles).catch(() => setProjectFiles([]));
  }, [workspace?.root]);

  useEffect(() => {
    if (!workspace?.root) return;
    if (indexedRoot.current === workspace.root) return;
    indexedRoot.current = workspace.root;
    fetch(apiUrl("/index/build"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ projectRoot: workspace.root }),
    }).catch(() => undefined);
  }, [workspace?.root]);

  useEffect(() => {
    if (!workspace?.root) return;
    if (autoOpenedRoot.current === workspace.root) return;
    autoOpenedRoot.current = workspace.root;
    let cancelled = false;
    (async () => {
      try {
        const entries = await window.orvyn.project.listDirectory(".");
        if (cancelled) return;
        const readme = entries.find((e) => !e.isDirectory && /^readme(\.md)?$/i.test(e.name));
        if (!readme) return;
        const content = await window.orvyn.project.readFile(readme.name);
        if (cancelled) return;
        setTabs((prev) => (prev.some((t) => t.path === readme.name) ? prev : [...prev, { path: readme.name, content }]));
        setActivePath((path) => path ?? readme.name);
      } catch {
        // Built-in workspace may not have a README yet.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace?.root]);

  function upsertTab(path: string, content: string, dirty = false) {
    setTabs((prev) => {
      const existing = prev.find((t) => t.path === path);
      if (existing) {
        return prev.map((t) => (t.path === path ? { ...t, content, dirty } : t));
      }
      return [...prev, { path, content, dirty }];
    });
    setActivePath(path);
    setView("editor");
  }

  async function applyWorkspace(next: WorkspaceState | null, fileRelative?: string) {
    if (!next) return;
    setWorkspace(next);
    if (fileRelative) {
      const content = await window.orvyn.project.readFile(fileRelative);
      upsertTab(fileRelative, content);
      return;
    }
    setView("editor");
  }

  async function handleOpenProject() {
    await applyWorkspace(await window.orvyn.project.open());
  }

  async function handleOpenRecent(folder: string) {
    await applyWorkspace(await window.orvyn.project.openPath(folder));
  }

  async function handleOpenFileDialog() {
    const next = await window.orvyn.project.openFile();
    await applyWorkspace(next, next?.fileRelative);
  }

  async function handleCloseFolder() {
    const next = await window.orvyn.project.close();
    autoOpenedRoot.current = null;
    indexedRoot.current = null;
    setWorkspace(next);
    setTabs([]);
    setActivePath(null);
    setView("editor");
  }

  async function handleOpenFile(relativePath: string) {
    const existing = tabs.find((t) => t.path === relativePath);
    if (existing) {
      setActivePath(relativePath);
      setView("editor");
      return;
    }
    const content = await window.orvyn.project.readFile(relativePath);
    upsertTab(relativePath, content);
  }

  function handleCloseTab(path: string) {
    setTabs((prev) => {
      const next = prev.filter((t) => t.path !== path);
      if (activePath === path) {
        setActivePath(next.length ? next[next.length - 1].path : null);
      }
      return next;
    });
  }

  function handleApplyCode(code: string) {
    if (openFile) {
      upsertTab(openFile.path, code, true);
      return;
    }
    upsertTab("untitled.txt", code, true);
  }

  const paletteCommands: PaletteCommand[] = [
    { id: "open-folder", label: "Open Folder", run: () => { void handleOpenProject(); } },
    { id: "open-file", label: "Open File…", run: () => { void handleOpenFileDialog(); } },
    { id: "new-chat", label: "New Chat", run: () => { newChat(); setView("newtask"); setCenterMode("work"); setActiveRunId(null); } },
    { id: "focus-chat", label: "Focus ORVYN Composer", run: () => { setView("newtask"); setCenterMode("work"); setTimeout(() => document.dispatchEvent(new CustomEvent("orvyn:focus-composer")), 50); } },
    {
      id: "index",
      label: "Rebuild Codebase Index",
      run: () => {
        if (!workspace?.root) return;
        fetch(apiUrl("/index/build"), {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ projectRoot: workspace.root }),
        }).catch(() => undefined);
      },
    },
    { id: "models", label: "Open Model Manager", run: () => setView("models") },
    { id: "search", label: "Open Codebase Search", run: () => setView("search") },
  ];

  const appMenus: Menu[] = [
    {
      label: "File",
      items: [
        { label: "Open Folder…", accelerator: "Ctrl+K Ctrl+O", onClick: () => void handleOpenProject() },
        { label: "Open File…", accelerator: "Ctrl+O", onClick: () => void handleOpenFileDialog() },
        { separator: true },
        { label: "Quick Open…", accelerator: "Ctrl+P", onClick: () => setPalette("files") },
        ...(workspace?.kind === "folder"
          ? [{ separator: true as const }, { label: "Close Folder", onClick: () => void handleCloseFolder() }]
          : []),
        { separator: true },
        { label: "Exit", onClick: () => void window.orvyn.window.close() },
      ],
    },
    {
      label: "Edit",
      items: [
        { label: "Undo", accelerator: "Ctrl+Z", onClick: () => document.execCommand("undo") },
        { label: "Redo", accelerator: "Ctrl+Y", onClick: () => document.execCommand("redo") },
        { separator: true },
        { label: "Cut", accelerator: "Ctrl+X", onClick: () => document.execCommand("cut") },
        { label: "Copy", accelerator: "Ctrl+C", onClick: () => document.execCommand("copy") },
        { label: "Paste", accelerator: "Ctrl+V", onClick: () => document.execCommand("paste") },
        { separator: true },
        { label: "Inline Edit (AI)", accelerator: "Ctrl+K", disabled: !openFile },
      ],
    },
    {
      label: "View",
      items: [
        { label: "Command Palette…", accelerator: "Ctrl+Shift+P", onClick: () => setPalette("commands") },
        { separator: true },
        { label: "Explorer", onClick: () => setView("editor") },
        { label: "Search & RAG", onClick: () => setView("search") },
        { label: "AI Models", onClick: () => setView("models") },
        { separator: true },
        { label: "Toggle Developer Tools", accelerator: "Ctrl+Shift+I", onClick: () => void window.orvyn.window.toggleDevTools() },
        { label: "Reload", accelerator: "Ctrl+R", onClick: () => void window.orvyn.window.reload() },
      ],
    },
    {
      label: "Window",
      items: [
        { label: "Minimize", onClick: () => void window.orvyn.window.minimize() },
        { label: "Maximize / Restore", onClick: () => void window.orvyn.window.toggleMaximize() },
        { separator: true },
        { label: "Close Window", onClick: () => void window.orvyn.window.close() },
      ],
    },
    {
      label: "Help",
      items: [
        { label: "Connection Settings", onClick: () => setView("settings") },
        { label: "Keyboard Shortcuts", onClick: () => setPalette("commands") },
        { separator: true },
        { label: "About ORVYN", onClick: () => window.alert("ORVYN — Your Code. Your Models. Your AI.") },
      ],
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", minWidth: 0, background: "var(--bg-app)", color: "var(--text)" }}>
      <TitleBar
        menus={appMenus}
        title={openFile ? openFile.path : workspace?.root ?? "ORVYN"}
        // Usage/plan chips removed from the title bar: the redesigned screens
        // and the status bar already present this — showing it twice was the
        // reported duplicate-header issue.
        onOpenCommand={() => setPalette("commands")}
        onOpenSettings={() => setView("settings")}
        onSwitchWorkspace={() => setView("projects")}
      />

      <div style={{ display: "flex", flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden" }}>
        <Sidebar
          view={view}
          onChange={(v) => {
            setView(v);
            if (v === "newtask") {
              newChat();
              setCenterMode("work");
              setActiveRunId(null);
              setTimeout(() => document.dispatchEvent(new CustomEvent("orvyn:focus-composer")), 50);
            }
            if (v === "home") setCenterMode("home");
          }}
          workspace={{ name: projectName ?? "No project", subtitle: presentation.workspaceLabel }}
          user={{ name: presentation.userName, subtitle: presentation.userSubtitle }}
          usage={{ valueLabel: agentRun.usage ? `${((agentRun.usage.promptTokens + agentRun.usage.completionTokens) / 1000).toFixed(1)}k` : "—", limitLabel: "current run", percent: agentRun.usage ? Math.min(100, ((agentRun.usage.promptTokens + agentRun.usage.completionTokens) / Math.max(agentRun.usage.contextBudget || 2_000_000, 1)) * 100) : 0 }}
          missionsNeedingYou={homeMissions.filter(m => ["approval","blocked","paused"].includes(m.tone)).length}
          onNewMission={() => { newChat(); setView("newtask"); setCenterMode("work"); setActiveRunId(null); }}
          onOpenSettings={() => setView("settings")}
          onOpenUsage={() => setView("usage")}
        />

        {showEditorChrome && (
          <>
            <ResizablePanel side="left" defaultWidth={220} minWidth={160}>
              <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
                <FileExplorer
                  workspace={workspace}
                  onOpenFile={handleOpenFile}
                  onOpenFolder={handleOpenProject}
                  onOpenRecent={handleOpenRecent}
                  onCloseFolder={handleCloseFolder}
                />
              </div>
            </ResizablePanel>

            <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column", background: "var(--bg-panel)", position: "relative" }}>
              <EditorTabs
                tabs={tabs}
                activePath={activePath}
                onSelect={setActivePath}
                onClose={handleCloseTab}
              />
              {openFile ? (
                <Editor
                  height="100%"
                  theme="orvyn-dark"
                  path={openFile.path}
                  language={guessLanguage(openFile.path)}
                  defaultLanguage={guessLanguage(openFile.path)}
                  value={openFile.content}
                  options={{
                    fontSize: 13,
                    fontFamily: "JetBrains Mono, Cascadia Code, Consolas, monospace",
                    minimap: { enabled: false },
                    padding: { top: 8 },
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    wordWrap: "off",
                    renderLineHighlight: "line",
                    bracketPairColorization: { enabled: true },
                    inlineSuggest: { enabled: true },
                    quickSuggestions: { other: false, comments: false, strings: false },
                  }}
                  onMount={(editor) => inlineEdit.attach(editor)}
                  onChange={(value) =>
                    setTabs((prev) =>
                      prev.map((t) =>
                        t.path === openFile.path ? { ...t, content: value ?? "", dirty: true } : t
                      )
                    )
                  }
                />
              ) : (
                <EmptyEditor onOpenFile={handleOpenFileDialog} />
              )}
              {inlineEdit.state && openFile && (
                <InlineEdit
                  selection={inlineEdit.state.selection}
                  language={inlineEdit.state.language}
                  filePath={openFile.path}
                  fileContent={openFile.content}
                  onAccept={(text) => inlineEdit.accept(text)}
                  onClose={inlineEdit.close}
                />
              )}
            </div>
          </>
        )}

        {(view === "home" || view === "newtask") && (
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" }}>
            {/* Deterministic center routing — the nav selection (view) ALWAYS
                wins over the remembered working mode. Home selected = the
                animated landing screen, no stale WorkStream underneath. The
                active run/chat is only hidden, never destroyed. */}
            {view === "home" ? (
              <div className="ov-app" style={{ height: "100%" }}>
                <HomeScreen userName={presentation.userName} statusLine={heroLine} workspaceName={projectName ?? "No project"} status={{ engineReady: facts.localEngineState === "ready", cloudOnline, agentsRunning: 0 }} missions={homeMissions} systems={toSystems({ engineReady: runtimeCaps.engineReady, githubConnected: runtimeCaps.githubConnected, sshHostCount: runtimeCaps.sshHostCount, postgresConnected: runtimeCaps.postgresConnected, dockerConnected: runtimeCaps.dockerAvailable, cloudSignedIn: presentation.signedIn })} agentName="ORION" agentRole="orchestrator" onRun={(prompt, mode) => { void submitOrvynCommand({ prompt, mode, source: "HOME", projectRoot: workspaceRoot }).then(outcome => { setCenterMode("work"); setView("newtask"); if (outcome.kind === "mission" || outcome.kind === "run") { newChat(); setActiveRunId(outcome.runId); } }); }} onOpenMission={(id) => { const m=homeMissions.find(x=>x.id===id); if(m?.runId){ newChat(); setActiveRunId(m.runId); setCenterMode("work"); setView("newtask"); } else setView("missions"); }} onConnectSystem={(id) => { if (id === "ssh") setView("servers"); else if (id === "github") setView("scm"); else if (id === "cloud") setView("settings"); else if (id === "docker") setView("containers"); else if (id === "postgres") setView("databases"); }} onViewAllMissions={() => setView("missions")} onOpenCommand={() => setPalette("commands")} />
              </div>
            ) : view === "newtask" && missionDetail && activeRunId ? (
              <div className="ov-app" style={{ height: "100%" }}><MissionDetail mission={missionDetailFromRuntime(missionDetail, agentRun.events)} onBack={() => { setActiveRunId(null); setMissionDetail(null); setCenterMode("home"); setView("home"); }} onApprove={(id, remember) => void agentRun.approve(id, true, remember ? "mission" : "once")} onDeny={(id) => void agentRun.approve(id, false)} onReply={(text) => void agentRun.steer(text)} onStop={() => void agentRun.stop()} /></div>
            ) : view === "newtask" && centerMode === "work" ? (
              <WorkStream projectRoot={workspaceRoot} projectName={projectName} run={runView} onRunStarted={(runId) => setActiveRunId(runId)} />
            ) : (
              <div className="ov-app" style={{ height: "100%" }}>
                <HomeScreen userName={presentation.userName} statusLine={heroLine} workspaceName={projectName ?? "No project"} status={{ engineReady: facts.localEngineState === "ready", cloudOnline, agentsRunning: 0 }} missions={homeMissions} systems={toSystems({ engineReady: runtimeCaps.engineReady, githubConnected: runtimeCaps.githubConnected, sshHostCount: runtimeCaps.sshHostCount, postgresConnected: runtimeCaps.postgresConnected, dockerConnected: runtimeCaps.dockerAvailable, cloudSignedIn: presentation.signedIn })} agentName="ORION" agentRole="orchestrator" onRun={(prompt, mode) => { void submitOrvynCommand({ prompt, mode, source: "HOME", projectRoot: workspaceRoot }).then(outcome => { setCenterMode("work"); setView("newtask"); if (outcome.kind === "mission" || outcome.kind === "run") { newChat(); setActiveRunId(outcome.runId); } }); }} onOpenMission={(id) => { const m=homeMissions.find(x=>x.id===id); if(m?.runId){ newChat(); setActiveRunId(m.runId); setCenterMode("work"); setView("newtask"); } else setView("missions"); }} onConnectSystem={(id) => { if (id === "ssh") setView("servers"); else if (id === "github") setView("scm"); else if (id === "cloud") setView("settings"); else if (id === "docker") setView("containers"); else if (id === "postgres") setView("databases"); }} onViewAllMissions={() => setView("missions")} onOpenCommand={() => setPalette("commands")} />
              </div>
            )}
          </div>
        )}

        {view === "servers" && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <ServersWorkspace projectRoot={workspaceRoot} />
          </div>
        )}

        {view === "tools" && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <ToolsMcpWorkspace projectRoot={workspaceRoot} />
          </div>
        )}

        {view === "agents" && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <AgentsWorkspace />
          </div>
        )}

        {view === "projects" && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <ProjectsWorkspace onOpenFolder={() => void handleOpenProject()} />
          </div>
        )}

        {view === "automations" && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <HonestState
              title="AUTOMATIONS — NOT AVAILABLE YET"
              message="Scheduled and recurring work needs a scheduler service (cron-style triggers with per-run permissions and history). The mission engine it will drive is already live; the scheduler is the missing piece and is on the roadmap."
            />
          </div>
        )}

        {view === "containers" && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <HonestState
              title="CONTAINERS — NOT AVAILABLE YET"
              message="Container management requires a Docker connection per server. Cloud missions already execute in isolated containers on the backend; a live container browser (inspect/logs/restart) is the next step."
            />
          </div>
        )}

        {view === "databases" && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <HonestState
              title="DATABASES — NOT AVAILABLE YET"
              message="Database connections and query tooling arrive with the commercial data layer (PostgreSQL). Credentials will live server-side and never reach the models."
            />
          </div>
        )}

        {view === "cloud" && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <HonestState
              title="CLOUD — OVH CONNECTED"
              message="Your ORVYN backend runs on OVH (40.160.11.123) and executes cloud missions in Docker sandboxes. A cloud resource browser (per-provider inventory) is future work; provider support beyond OVH has not been implemented."
            />
          </div>
        )}

        {view === "browser" && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <HonestState
              title="BROWSER — NEEDS PLAYWRIGHT"
              message="The browser agent tools exist and are permission-gated; they become live when Playwright is installed as the backend's optional dependency. Until then the agent reports 'Playwright is not installed' rather than pretending."
            />
          </div>
        )}

        {view === "billing" && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <HonestState
              title="BILLING — NEEDS THE COMMERCIAL BACKEND"
              message="Plans, credit wallets, and Stripe checkout are designed (docs/COMMERCIAL_PLATFORM_AUDIT.md, Phases C–E) but not implemented yet. Usage metering — the data billing will be built on — is live and visible under Usage & Credits."
            />
          </div>
        )}

        {view === "memory" && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <MemoryPanel
              projectRoot={workspaceRoot}
              onOpenChat={() => {
                setView("newtask");
                setCenterMode("work");
              }}
            />
          </div>
        )}

        {view === "chats" && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <ChatsWorkspace
              onOpenChat={(id) => {
                // Resume: load the conversation, enter the work stream.
                openChatSession(id);
                setCenterMode("work");
                setView("newtask");
              }}
            />
          </div>
        )}

        {view === "usage" && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <ReportsPanel />
          </div>
        )}

        {view === "search" && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <SearchPanel workspaceRoot={workspaceRoot} workspaceKind={workspace?.kind ?? "default"} />
          </div>
        )}

        {view === "missions" && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <MissionControl projectRoot={workspaceRoot} />
          </div>
        )}

        {view === "scm" && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <GitScmPanel projectRoot={workspaceRoot} />
          </div>
        )}

        {view === "models" && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <ModelManager />
          </div>
        )}

        {view === "settings" && (
          <div style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
            <ConnectionSettings />
          </div>
        )}

        {/* RIGHT: the dynamic context workspace. No chat lives here — the
            center WorkStream is the single conversation. */}
        {showContext && (
          <ResizablePanel side="right" defaultWidth={360} minWidth={260} maxWidth={640}>
            <ContextPanel
              events={agentRun.events}
              runStatus={agentRun.status}
              projectRoot={workspaceRoot}
              onOpenFile={(p) => {
                setView("editor");
                void handleOpenFile(p);
              }}
            />
          </ResizablePanel>
        )}
      </div>

      {(view === "editor" || view === "terminal") && <BottomPanel />}

      <StatusBar />
      {palette && (
        <CommandPalette
          mode={palette}
          files={projectFiles}
          commands={paletteCommands}
          onOpenFile={(path) => {
            void handleOpenFile(path);
          }}
          onClose={() => setPalette(null)}
        />
      )}
    </div>
  );
}

function EmptyEditor({ onOpenFile }: { onOpenFile: () => void }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        color: "var(--text-muted)",
        padding: 24,
      }}
    >
      <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>No file open</div>
      <div style={{ fontSize: 12, maxWidth: 340, textAlign: "center", lineHeight: 1.55 }}>
        The center pane is the file viewer. Pick a file in the explorer, or open one from File → Open File. Chat stays on the right. Select code and press Ctrl+K to rewrite it.
      </div>
      <button onClick={onOpenFile} style={headerBtn()}>
        Open File
      </button>
    </div>
  );
}

function headerBtn(): React.CSSProperties {
  return {
    background: "transparent",
    border: "1px solid var(--border-strong)",
    color: "var(--text)",
    borderRadius: "var(--radius)",
    padding: "3px 8px",
    cursor: "pointer",
  };
}

function AiTabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        padding: "8px 0",
        background: "transparent",
        border: "none",
        borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
        color: active ? "var(--text)" : "var(--text-secondary)",
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}
