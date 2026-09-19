import React, { useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { FileExplorer } from "./components/FileExplorer";
import { AIChatPanel } from "./components/AIChatPanel";
import { ModelManager } from "./components/ModelManager";
import { ChatHistoryPanel } from "./components/ChatHistoryPanel";
import { ReportsPanel } from "./components/ReportsPanel";
import { ComposerPanel } from "./components/ComposerPanel";
import { AgentPanel } from "./components/AgentPanel";
import { SearchPanel } from "./components/SearchPanel";
import { ConnectionSettings } from "./components/ConnectionSettings";
import { ActivityBar, ViewId } from "./components/ActivityBar";
import { EditorTabs } from "./components/EditorTabs";
import { loadConnectionConfig, apiUrl, authHeaders } from "./connection";
import { WorkspaceState } from "./orvyn-bridge";
import { newChat } from "./chatSession";
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

type AiTab = "chat" | "plan" | "build" | "review";

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
  const [view, setView] = useState<ViewId>("editor");
  const [aiTab, setAiTab] = useState<AiTab>("chat");
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [projectFiles, setProjectFiles] = useState<string[]>([]);
  const autoOpenedRoot = useRef<string | null>(null);
  const indexedRoot = useRef<string | null>(null);

  const openFile = tabs.find((t) => t.path === activePath) ?? null;
  const workspaceRoot = workspace?.root ?? null;
  const showEditorChrome = view === "editor";
  const inlineEdit = useInlineEdit(openFile?.path);

  useEffect(() => {
    const dispose = registerTabAutocomplete();
    loadConnectionConfig().then(() => window.orvyn.project.getWorkspace().then(setWorkspace));
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
    { id: "new-chat", label: "New Chat", run: () => { setView("editor"); setAiTab("chat"); newChat(); } },
    { id: "focus-chat", label: "Focus Chat", run: () => { setView("editor"); setAiTab("chat"); } },
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
      <TitleBar menus={appMenus} title={openFile ? openFile.path : workspace?.root ?? "ORVYN"} />

      <div style={{ display: "flex", flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden" }}>
        <ActivityBar
          view={view}
          onChange={setView}
          chatActive={view === "editor" && aiTab === "chat"}
          onFocusChat={() => {
            setView("editor");
            setAiTab("chat");
          }}
          onNewChat={newChat}
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

            <ResizablePanel side="right" defaultWidth={400} minWidth={280} maxWidth={700}>
              <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, minWidth: 0 }}>
              <div style={{ display: "flex", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
                <AiTabButton label="Chat" active={aiTab === "chat"} onClick={() => setAiTab("chat")} />
                <AiTabButton label="Plan" active={aiTab === "plan"} onClick={() => setAiTab("plan")} />
                <AiTabButton label="Build" active={aiTab === "build"} onClick={() => setAiTab("build")} />
                <AiTabButton label="Review" active={aiTab === "review"} onClick={() => setAiTab("review")} />
              </div>
              <div style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden" }}>
                {aiTab === "chat" && (
                  <AIChatPanel
                    currentFile={openFile}
                    workspace={workspace}
                    projectFiles={projectFiles}
                    onApplyCode={handleApplyCode}
                  />
                )}
                {aiTab === "plan" && (
                  <ComposerPanel workspaceRoot={workspaceRoot} workspaceKind={workspace?.kind ?? "default"} />
                )}
                {aiTab === "build" && (
                  <AgentPanel workspaceRoot={workspaceRoot} workspaceKind={workspace?.kind ?? "default"} />
                )}
                {aiTab === "review" && <ReviewPanel />}
              </div>
              </div>
            </ResizablePanel>
          </>
        )}

        {view === "chats" && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <ChatHistoryPanel
              onOpenChat={() => {
                setView("editor");
                setAiTab("chat");
              }}
              onNewChat={newChat}
            />
          </div>
        )}

        {view === "reports" && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <ReportsPanel />
          </div>
        )}

        {view === "search" && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <SearchPanel workspaceRoot={workspaceRoot} workspaceKind={workspace?.kind ?? "default"} />
          </div>
        )}

        {view === "agents" && (
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
      </div>

      {showEditorChrome && <BottomPanel />}

      <div
        style={{
          height: 28,
          background: "var(--bg-panel)",
          borderTop: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          fontSize: 12,
          color: "var(--text-secondary)",
        }}
      >
        {workspace?.kind === "folder" ? "Folder workspace" : "Built-in workspace"} · Ctrl+P files · Ctrl+Shift+P commands · Ctrl+K edit · Tab complete
      </div>
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
