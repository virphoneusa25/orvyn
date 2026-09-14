import React, { useEffect, useState } from "react";
import { DirEntry } from "../viride-bridge";

export function FileExplorer({
  projectRoot,
  onOpenFile,
}: {
  projectRoot: string | null;
  onOpenFile: (relativePath: string) => void;
}) {
  const [entries, setEntries] = useState<DirEntry[]>([]);

  useEffect(() => {
    if (!projectRoot) return;
    window.viride.project.listDirectory(".").then(setEntries);
  }, [projectRoot]);

  if (!projectRoot) {
    return (
      <div style={{ padding: 16, color: "#8b93a7", fontSize: 13 }}>
        No project open.
      </div>
    );
  }

  return (
    <div style={{ padding: 8, fontSize: 13, color: "#c9d1e0" }}>
      <div style={{ padding: "4px 8px", opacity: 0.6, textTransform: "uppercase", fontSize: 11 }}>
        {projectRoot.split(/[\\/]/).pop()}
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
    </div>
  );
}
