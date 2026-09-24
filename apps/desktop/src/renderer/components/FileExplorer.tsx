import React, { useCallback, useEffect, useState } from "react";
import { DirEntry, WorkspaceState } from "../orvyn-bridge";

// Code view explorer: ONLY the files in the open folder, as a tree you can
// expand. ORION's generated files and run artifacts live in the Files tab
// (with Cloud / This computer labels), not here, so this list always matches
// what is on disk in the folder.

export function FileExplorer({
  workspace,
  onOpenFile,
  onOpenFolder,
  onOpenRecent,
  onCloseFolder,
  onBackToChat,
  activePath,
}: {
  workspace: WorkspaceState | null;
  onOpenFile: (relativePath: string) => void;
  onOpenFolder: () => void;
  onOpenRecent: (folder: string) => void;
  onCloseFolder: () => void;
  /** Leaves the Code view and returns to the current conversation. */
  onBackToChat?: () => void;
  /** The file shown in the editor, highlighted in the tree. */
  activePath?: string | null;
}) {
  const [confirmClose, setConfirmClose] = useState(false);
  const [dirs, setDirs] = useState<Record<string, DirEntry[] | "error">>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const root = workspace?.root ?? null;
  const isFolder = workspace?.kind === "folder";

  const load = useCallback(async (rel: string) => {
    try {
      const entries = await window.orvyn.project.listDirectory(rel);
      const sorted = [...entries].sort((a, b) =>
        a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1
      );
      setDirs((d) => ({ ...d, [rel]: sorted }));
    } catch {
      setDirs((d) => ({ ...d, [rel]: "error" }));
    }
  }, []);

  useEffect(() => {
    setDirs({});
    setExpanded(new Set());
    setConfirmClose(false);
    if (root && isFolder) void load(".");
  }, [root, isFolder, load]);

  const refresh = () => {
    void load(".");
    expanded.forEach((rel) => void load(rel));
  };

  const toggle = (rel: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else {
        next.add(rel);
        if (!dirs[rel]) void load(rel);
      }
      return next;
    });
  };

  const renderDir = (rel: string, depth: number): React.ReactNode => {
    const list = dirs[rel];
    if (!list) return <div style={{ ...muted, paddingLeft: 12 + depth * 14 }}>Loading…</div>;
    if (list === "error") return <div style={{ ...muted, paddingLeft: 12 + depth * 14 }}>Could not read this folder.</div>;
    if (list.length === 0) return <div style={{ ...muted, paddingLeft: 12 + depth * 14 }}>Empty</div>;
    return list.map((entry) => {
      const path = rel === "." ? entry.name : `${rel}/${entry.name}`;
      const open = expanded.has(path);
      const active = !entry.isDirectory && activePath === path;
      return (
        <React.Fragment key={path}>
          <div
            onClick={() => (entry.isDirectory ? toggle(path) : onOpenFile(path))}
            title={path}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "3px 8px", paddingLeft: 8 + depth * 14,
              cursor: "pointer", borderRadius: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              background: active ? "rgba(99,102,241,0.16)" : "transparent",
              color: active ? "#F5F7FF" : "#c9d1e0",
            }}
            onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "#161b26"; }}
            onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
          >
            <span aria-hidden="true" style={{ width: 10, flex: "none", color: "#6b7389", fontSize: 10 }}>
              {entry.isDirectory ? (open ? "▾" : "▸") : ""}
            </span>
            <span aria-hidden="true" style={{ flex: "none", color: entry.isDirectory ? "#8b93a7" : "#6b7389" }}>
              {entry.isDirectory ? <FolderGlyph /> : <FileGlyph />}
            </span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{entry.name}</span>
          </div>
          {entry.isDirectory && open && renderDir(path, depth + 1)}
        </React.Fragment>
      );
    });
  };

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

      {isFolder ? (
        <>
          <div style={{ padding: "4px 8px 8px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <span title={workspace!.root} style={{ opacity: 0.6, textTransform: "uppercase", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {workspace!.root.split(/[\\/]/).pop()}
            </span>
            <span style={{ display: "inline-flex", gap: 10, alignItems: "center", flex: "none" }}>
              <button onClick={refresh} title="Reload the file list" style={linkBtn}>Refresh</button>
              {!confirmClose && (
                <button onClick={() => setConfirmClose(true)} title="Closes this project folder in ORVYN. Nothing is deleted." style={linkBtn}>
                  Close folder
                </button>
              )}
            </span>
          </div>
          {confirmClose && (
            <div style={{ margin: "0 4px 8px", padding: "8px 10px", borderRadius: 8, border: "1px solid #2a3348", background: "#0E1421", fontSize: 11, lineHeight: 1.5 }}>
              Close this folder in ORVYN? Nothing on your computer is deleted.
              <div style={{ display: "flex", gap: 12, marginTop: 6 }}>
                <button onClick={() => { setConfirmClose(false); onCloseFolder(); }} style={{ ...linkBtn, color: "#F25F75" }}>Close folder</button>
                <button onClick={() => setConfirmClose(false)} style={linkBtn}>Cancel</button>
              </div>
            </div>
          )}
          {renderDir(".", 0)}
        </>
      ) : (
        <div style={{ padding: "4px 8px" }}>
          <div style={{ fontSize: 12, color: "#8b93a7", lineHeight: 1.5, marginBottom: 10 }}>
            No folder open. Open a project folder to see its files here. Files ORION made in ORVYN Cloud are in the Files tab.
          </div>
          <button
            onClick={onOpenFolder}
            style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: "1px solid rgba(129,140,248,0.4)", background: "rgba(99,102,241,0.12)", color: "#F5F7FF", fontSize: 12, cursor: "pointer" }}
          >
            Open folder…
          </button>
          {(workspace?.recents.length ?? 0) > 0 && (
            <div style={{ marginTop: 16 }}>
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
      )}
    </div>
  );
}

const muted: React.CSSProperties = { fontSize: 11, color: "#6b7389", padding: "3px 8px" };
const linkBtn: React.CSSProperties = { background: "transparent", border: "none", color: "#8b93a7", fontSize: 11, cursor: "pointer", padding: 0, whiteSpace: "nowrap" };

function FolderGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M1.5 4.5a1 1 0 0 1 1-1h3.6l1.4 1.5h5.9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-10.9a1 1 0 0 1-1-1z" />
    </svg>
  );
}

function FileGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M4 1.5h5.5L13 5v9.5H4z" />
      <path d="M9.5 1.5V5H13" />
    </svg>
  );
}
