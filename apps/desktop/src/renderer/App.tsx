import React, { useEffect, useState } from "react";
import Editor from "@monaco-editor/react";
import { FileExplorer } from "./components/FileExplorer";
import { AIChatPanel } from "./components/AIChatPanel";
import { ModelManager } from "./components/ModelManager";
import { ComposerPanel } from "./components/ComposerPanel";
import { AgentPanel } from "./components/AgentPanel";
import { SearchPanel } from "./components/SearchPanel";
import { ConnectionSettings } from "./components/ConnectionSettings";
import { loadConnectionConfig } from "./connection";

type View = "editor" | "models" | "search" | "settings";
type AiTab = "chat" | "composer" | "agent";

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
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<{ path: string; content: string } | null>(null);
  const [view, setView] = useState<View>("editor");
  const [aiTab, setAiTab] = useState<AiTab>("chat");

  useEffect(() => {
    loadConnectionConfig();
  }, []);

  async function handleOpenProject() {
    const root = await window.viride.project.open();
    if (root) setProjectRoot(root);
  }

  async function handleOpenFile(relativePath: string) {
    const content = await window.viride.project.readFile(relativePath);
    setOpenFile({ path: relativePath, content });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Title bar */}
      <div
        style={{
          height: 40,
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          background: "#0d111a",
          borderBottom: "1px solid #1c2330",
          color: "#e6e9f0",
          fontSize: 13,
          gap: 16,
        }}
      >
        <strong>VirIDE</strong>
        <button
          onClick={handleOpenProject}
          style={{ background: "transparent", border: "1px solid #2a3244", color: "#c9d1e0", borderRadius: 4, padding: "3px 8px", cursor: "pointer" }}
        >
          Open Folder
        </button>
        <span style={{ opacity: 0.6 }}>{projectRoot ?? "No project open"}</span>
        <span style={{ marginLeft: "auto", opacity: 0.6 }}>Model: viride-mock</span>
      </div>

      {/* Main layout: activity bar + explorer/content + AI panel */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Activity Bar */}
        <div
          style={{
            width: 48,
            background: "#080a10",
            borderRight: "1px solid #1c2330",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            paddingTop: 8,
            gap: 4,
          }}
        >
          <ActivityBarIcon label="Explorer" icon="📁" active={view === "editor"} onClick={() => setView("editor")} />
          <ActivityBarIcon label="Search / RAG" icon="🔍" active={view === "search"} onClick={() => setView("search")} />
          <ActivityBarIcon label="AI Models" icon="🧠" active={view === "models"} onClick={() => setView("models")} />
          <ActivityBarIcon label="Connection" icon="⚙️" active={view === "settings"} onClick={() => setView("settings")} />
        </div>

        {view === "editor" && (
          <>
            <div style={{ width: 220, background: "#0d111a", borderRight: "1px solid #1c2330", overflowY: "auto" }}>
              <FileExplorer projectRoot={projectRoot} onOpenFile={handleOpenFile} />
            </div>

            <div style={{ flex: 1, minWidth: 0 }}>
              {openFile ? (
                <Editor
                  height="100%"
                  theme="vs-dark"
                  path={openFile.path}
                  defaultLanguage={guessLanguage(openFile.path)}
                  value={openFile.content}
                  onChange={(value) => setOpenFile((f) => (f ? { ...f, content: value ?? "" } : f))}
                />
              ) : (
                <div style={{ display: "flex", height: "100%", alignItems: "center", justifyContent: "center", color: "#5a6478" }}>
                  Open a file to start editing
                </div>
              )}
            </div>

            <div style={{ width: 400, background: "#0d111a", borderLeft: "1px solid #1c2330", display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", borderBottom: "1px solid #1c2330" }}>
                <AiTabButton label="Chat" active={aiTab === "chat"} onClick={() => setAiTab("chat")} />
                <AiTabButton label="Composer" active={aiTab === "composer"} onClick={() => setAiTab("composer")} />
                <AiTabButton label="Agent" active={aiTab === "agent"} onClick={() => setAiTab("agent")} />
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                {aiTab === "chat" && <AIChatPanel currentFile={openFile} />}
                {aiTab === "composer" && <ComposerPanel projectRoot={projectRoot} />}
                {aiTab === "agent" && <AgentPanel projectRoot={projectRoot} />}
              </div>
            </div>
          </>
        )}

        {view === "search" && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <SearchPanel projectRoot={projectRoot} />
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

      {/* Bottom panel placeholder for Terminal / Problems / Git */}
      <div style={{ height: 28, background: "#0d111a", borderTop: "1px solid #1c2330", display: "flex", alignItems: "center", padding: "0 12px", fontSize: 12, color: "#8b93a7" }}>
        Terminal · Problems · Git — Phase 6
      </div>
    </div>
  );
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
        borderBottom: active ? "2px solid #3b5bfd" : "2px solid transparent",
        color: active ? "#e6e9f0" : "#8b93a7",
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function ActivityBarIcon({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      title={label}
      onClick={onClick}
      style={{
        width: 36,
        height: 36,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: active ? "#1c2330" : "transparent",
        border: "none",
        borderRadius: 8,
        fontSize: 16,
        cursor: "pointer",
        opacity: active ? 1 : 0.6,
      }}
    >
      {icon}
    </button>
  );
}
