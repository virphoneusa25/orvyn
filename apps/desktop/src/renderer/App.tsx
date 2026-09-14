import React, { useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { FileExplorer } from "./components/FileExplorer";
import { AIChatPanel } from "./components/AIChatPanel";
import { ModelManager } from "./components/ModelManager";
import { ComposerPanel } from "./components/ComposerPanel";
import { AgentPanel } from "./components/AgentPanel";
import { SearchPanel } from "./components/SearchPanel";
import { ConnectionSettings } from "./components/ConnectionSettings";
import { ActivityBar, ViewId } from "./components/ActivityBar";
import { EditorTabs } from "./components/EditorTabs";
import { loadConnectionConfig } from "./connection";
import { WorkspaceState } from "./orvyn-bridge";
import { newChat } from "./chatSession";
import { useInlineEdit } from "./useInlineEdit";
import { InlineEdit } from "./components/InlineEdit";
import appIcon from "./assets/icon.png";

type AiTab = "chat" | "composer" | "agent";

interface OpenFile {
  path: string;
  content: string;
  dirty?: boolean;
}

function guessLanguage(path: string): string {
  const ext = path.split(".").pop() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    py: "python",
    html: "html",
    css: "css",
  };
  return map[ext] ?? "plaintext";
}

export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [tabs, setTabs] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [view, setView] = useState<ViewId>("editor");
  const [aiTab, setAiTab] = useState<AiTab>("chat");
  const autoOpenedRoot = useRef<string | null>(null);

  const openFile = tabs.find((t) => t.path === activePath) ?? null;
  const workspaceRoot = workspace?.root ?? null;
  const showEditorChrome = view === "editor";
  const inlineEdit = useInlineEdit(openFile?.path);

  useEffect(() => {
    loadConnectionConfig();
    window.orvyn.project.getWorkspace().then(setWorkspace);
  }, []);

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

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg-app)", color: "var(--text)" }}>
      <div
        style={{
          height: 40,
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          background: "var(--bg-panel)",
          borderBottom: "1px solid var(--border)",
          fontSize: 13,
          gap: 12,
        }}
      >
        <img src={appIcon} alt="" width={22} height={22} style={{ borderRadius: 6, display: "block" }} />
        <strong style={{ letterSpacing: 0.8 }}>ORVYN</strong>
        <button onClick={handleOpenProject} style={headerBtn()}>
          Open Folder
        </button>
        <button onClick={handleOpenFileDialog} style={headerBtn()}>
          Open File
        </button>
        {workspace?.kind === "folder" && (
          <button onClick={handleCloseFolder} style={headerBtn()}>
            Close Folder
          </button>
        )}
        <span style={{ opacity: 0.55, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {workspace?.kind === "folder" ? workspace.root : "Built-in workspace · folder optional"}
        </span>
        <span style={{ marginLeft: "auto", color: "var(--text-muted)" }}>Chat on the right · files in the center</span>
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
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
            <div style={{ width: 220, background: "var(--bg-panel)", borderRight: "1px solid var(--border)", overflowY: "auto" }}>
              <FileExplorer
                workspace={workspace}
                onOpenFile={handleOpenFile}
                onOpenFolder={handleOpenProject}
                onOpenRecent={handleOpenRecent}
                onCloseFolder={handleCloseFolder}
              />
            </div>

            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", background: "var(--bg-panel)", position: "relative" }}>
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
                  defaultLanguage={guessLanguage(openFile.path)}
                  value={openFile.content}
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

            <div style={{ width: 400, background: "var(--bg-panel)", borderLeft: "1px solid var(--border)", display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", borderBottom: "1px solid var(--border)" }}>
                <AiTabButton label="Chat" active={aiTab === "chat"} onClick={() => setAiTab("chat")} />
                <AiTabButton label="Composer" active={aiTab === "composer"} onClick={() => setAiTab("composer")} />
                <AiTabButton label="Agent" active={aiTab === "agent"} onClick={() => setAiTab("agent")} />
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                {aiTab === "chat" && (
                  <AIChatPanel currentFile={openFile} workspace={workspace} onApplyCode={handleApplyCode} />
                )}
                {aiTab === "composer" && (
                  <ComposerPanel workspaceRoot={workspaceRoot} workspaceKind={workspace?.kind ?? "default"} />
                )}
                {aiTab === "agent" && (
                  <AgentPanel workspaceRoot={workspaceRoot} workspaceKind={workspace?.kind ?? "default"} />
                )}
              </div>
            </div>
          </>
        )}

        {view === "search" && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <SearchPanel workspaceRoot={workspaceRoot} workspaceKind={workspace?.kind ?? "default"} />
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
        {workspace?.kind === "folder" ? "Folder workspace" : "Built-in workspace"} · Chat · Composer · Agent · Ctrl+K
      </div>
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
        The center pane is the file viewer. Pick a file in the explorer, or open one from the header. Chat stays on the right. Select code and press Ctrl+K to rewrite it.
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
