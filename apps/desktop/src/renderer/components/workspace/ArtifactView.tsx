import React, { useState } from "react";
import { emptyBody, emptyTitle, ghostBtn } from "./workspaceChrome";

export function ArtifactView({
  name,
  content,
}: {
  name: string;
  content?: string | null;
}) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const isMd = ext === "md" || ext === "markdown";
  const isHtml = ext === "html" || ext === "htm";
  const isImage = ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext);
  const [mode, setMode] = useState<"render" | "raw">(isHtml || isMd || isImage ? "render" : "raw");

  if (!name) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 28, gap: 8, textAlign: "center" }}>
        <div style={emptyTitle()}>No artifact selected</div>
        <div style={emptyBody()}>Created documents and reports appear in Files → Artifacts.</div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderBottom: "1px solid var(--orvyn-border-soft)" }}>
        <code style={{ flex: 1, fontSize: 12 }}>{name}</code>
        {(isMd || isHtml) && (
          <button style={ghostBtn()} onClick={() => setMode(mode === "raw" ? "render" : "raw")}>
            {mode === "raw" ? (isMd ? "Rendered" : "Preview") : isMd ? "Raw" : "Source"}
          </button>
        )}
      </div>
      {isImage && content ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto", padding: 16 }}>
          <img src={content} alt={name} style={{ maxWidth: "100%", maxHeight: "100%" }} />
        </div>
      ) : mode === "render" && isHtml && content ? (
        <iframe title={name} sandbox="allow-scripts" srcDoc={content} style={{ flex: 1, border: "none", background: "#fff" }} />
      ) : (
        <pre style={{ flex: 1, overflow: "auto", margin: 0, padding: 12, whiteSpace: "pre-wrap", fontSize: 12, lineHeight: 1.6 }}>
          {content || "Artifact listed. Contents load when the file is readable in this workspace."}
        </pre>
      )}
    </div>
  );
}
