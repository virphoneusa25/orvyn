import React, { useEffect, useState } from "react";
import { DirEntry, WorkspaceState } from "../orvyn-bridge";
import { apiUrl, authHeaders } from "../connection";

type TreeFile = { id?: string; name: string; path: string; kind: string };

export function FileExplorer({
  workspace,
  onOpenFile,
  onOpenFolder,
  onOpenRecent,
  onCloseFolder,
}: {
  workspace: WorkspaceState | null;
  onOpenFile: (relativePath: string) => void;
  onOpenFolder: () => void;
  onOpenRecent: (folder: string) => void;
  onCloseFolder: () => void;
}) {
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
      <div style={{ padding: "4px 8px 8px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ opacity: 0.6, textTransform: "uppercase", fontSize: 11 }}>
          {isFolder ? workspace.root.split(/[\\/]/).pop() : "Project"}
        </span>
        <button
          onClick={isFolder ? onCloseFolder : onOpenFolder}
          style={{ background: "transparent", border: "none", color: "#8b93a7", fontSize: 11, cursor: "pointer" }}
        >
          {isFolder ? "Close" : "Open folder"}
        </button>
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

      <Section title="Generated" files={generated} onOpen={onOpenFile} />
      <Section title="Run Artifacts" files={artifacts} onOpen={onOpenFile} />

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

function Section({ title, files, onOpen }: { title: string; files: TreeFile[]; onOpen: (path: string) => void }) {
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
            onClick={() => onOpen(f.path)}
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
