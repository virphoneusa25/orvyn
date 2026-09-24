import React, { useEffect, useState } from "react";
import { DirEntry, WorkspaceState } from "../orvyn-bridge";
import { apiUrl, authHeaders } from "../connection";
import { isFabricatedGeneratedPath } from "../workbenchFileAccess";

type TreeFile = { id?: string; name: string; path: string; kind: string };

export function FileExplorer({
  workspace,
  onOpenFile,
  onOpenFolder,
  onOpenRecent,
  onCloseFolder,
  onBackToChat,
}: {
  workspace: WorkspaceState | null;
  onOpenFile: (relativePath: string) => void;
  onOpenFolder: () => void;
  onOpenRecent: (folder: string) => void;
  onCloseFolder: () => void;
  /** Leaves the Code view and returns to the current conversation. */
  onBackToChat?: () => void;
}) {
  const [confirmClose, setConfirmClose] = useState(false);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [generated, setGenerated] = useState<TreeFile[]>([]);
  const [artifacts, setArtifacts] = useState<TreeFile[]>([]);
  const root = workspace?.root ?? null;
  const isFolder = workspace?.kind === "folder";

  useEffect(() => {
    if (!root) return;
    window.orvyn.project.listDirectory(".").then(setEntries).catch(() => setEntries([]));
  }, [root]);

  useEffect(() => {
    const suffix = root ? `?projectRoot=${encodeURIComponent(root)}` : "";
    fetch(apiUrl("/files" + suffix), { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => {
        const locs = Array.isArray(d.locations) ? d.locations : [];
        setGenerated((locs.find((l: { id: string }) => l.id === "generated")?.files ?? []) as TreeFile[]);
        setArtifacts((locs.find((l: { id: string }) => l.id === "artifacts")?.files ?? []) as TreeFile[]);
      })
      .catch(() => {
        setGenerated([]);
        setArtifacts([]);
      });
  }, [root]);

  return (
    <div style={{ padding: 8, fontSize: 13, color: "#c9d1e0" }}>
      {onBackToChat && (
        <button
          onClick={onBackToChat}
          style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", margin: "0 0 8px", padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border-strong, #202A3C)", background: "var(--bg-elevated, #0E1421)", color: "var(--text, #F5F7FF)", fontSize: 12, cursor: "pointer" }}
        >
          <span aria-hidden="true">←</span> Back to chat
        </button>
      )}
      <div style={{ padding: "4px 8px 8px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span style={{ opacity: 0.6, textTransform: "uppercase", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {isFolder ? workspace.root.split(/[\\/]/).pop() : "Project"}
        </span>
        {isFolder ? (
          confirmClose ? (
            <span style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 11, color: "#c9d1e0", whiteSpace: "nowrap" }}>
              Close this folder?
              <button onClick={() => { setConfirmClose(false); onCloseFolder(); }} style={{ background: "transparent", border: "none", color: "#F25F75", fontSize: 11, cursor: "pointer", padding: 0 }}>Close</button>
              <button onClick={() => setConfirmClose(false)} style={{ background: "transparent", border: "none", color: "#8b93a7", fontSize: 11, cursor: "pointer", padding: 0 }}>Cancel</button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmClose(true)}
              title="Closes this project folder in ORVYN. Nothing is deleted."
              style={{ background: "transparent", border: "none", color: "#8b93a7", fontSize: 11, cursor: "pointer", whiteSpace: "nowrap" }}
            >
              Close folder
            </button>
          )
        ) : (
          <button onClick={onOpenFolder} style={{ background: "transparent", border: "none", color: "#8b93a7", fontSize: 11, cursor: "pointer" }}>
            Open folder
          </button>
        )}
      </div>

      {isFolder ? (
        entries.map((entry) => (
          <div
            key={entry.name}
            onClick={() => !entry.isDirectory && onOpenFile(entry.name)}
            style={{
              padding: "3px 12px",
              cursor: entry.isDirectory ? "default" : "pointer",
              borderRadius: 4,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#161b26")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            {entry.isDirectory ? "📁 " : "📄 "}
            {entry.name}
          </div>
        ))
      ) : (
        <div style={{ padding: "6px 12px 12px", fontSize: 12, color: "#8b93a7", lineHeight: 1.5 }}>
          No local folder. Generated files and artifacts still appear below — ask ORION for a logo or document without opening a project.
        </div>
      )}

      <Section title="Generated" files={generated} onOpen={onOpenFile} generated />
      <Section title="Run Artifacts" files={artifacts} onOpen={onOpenFile} generated />

      {!isFolder && (workspace?.recents.length ?? 0) > 0 && (
        <div style={{ marginTop: 16, padding: "0 8px" }}>
          <div style={{ opacity: 0.5, textTransform: "uppercase", fontSize: 11, marginBottom: 6 }}>Recent</div>
          {workspace!.recents.map((folder) => (
            <div
              key={folder}
              onClick={() => onOpenRecent(folder)}
              title={folder}
              style={{ padding: "4px 4px", cursor: "pointer", borderRadius: 4, fontSize: 12 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#161b26")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              {folder.split(/[\\/]/).pop()}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Section({ title, files, onOpen, generated = false }: { title: string; files: TreeFile[]; onOpen: (path: string) => void; generated?: boolean }) {
  return (
    <div style={{ marginTop: 14, padding: "0 8px" }}>
      <div style={{ opacity: 0.5, textTransform: "uppercase", fontSize: 11, marginBottom: 6 }}>
        {title}
        <span style={{ marginLeft: 6 }}>{files.length}</span>
      </div>
      {files.length === 0 ? (
        <div style={{ fontSize: 11, color: "#8b93a7", padding: "2px 4px" }}>Empty</div>
      ) : (
        files.map((f) => (
          <div
            key={f.id ?? f.path}
            onClick={() => onOpen(generated || isFabricatedGeneratedPath(f.path) || f.kind === "generated" || f.kind === "artifact" ? `generated/${f.name}` : f.path)}
            style={{ padding: "3px 4px", cursor: "pointer", borderRadius: 4, fontSize: 12 }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#161b26")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            ▣ {f.name}
          </div>
        ))
      )}
    </div>
  );
}
