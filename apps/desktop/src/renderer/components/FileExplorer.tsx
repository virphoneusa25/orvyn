import React, { useEffect, useState } from "react";
import { DirEntry, WorkspaceState } from "../orvyn-bridge";

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
  const root = workspace?.root ?? null;
  const isFolder = workspace?.kind === "folder";

  useEffect(() => {
    if (!root) return;
    window.orvyn.project.listDirectory(".").then(setEntries).catch(() => setEntries([]));
  }, [root]);

  return (
    <div style={{ padding: 8, fontSize: 13, color: "#c9d1e0" }}>
      <div style={{ padding: "4px 8px 8px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ opacity: 0.6, textTransform: "uppercase", fontSize: 11 }}>
          {isFolder ? workspace.root.split(/[\\/]/).pop() : "ORVYN workspace"}
        </span>
        <button
          onClick={isFolder ? onCloseFolder : onOpenFolder}
          style={{ background: "transparent", border: "none", color: "#8b93a7", fontSize: 11, cursor: "pointer" }}
        >
          {isFolder ? "Close" : "Open"}
        </button>
      </div>

      {entries.map((entry) => (
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
      ))}

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
