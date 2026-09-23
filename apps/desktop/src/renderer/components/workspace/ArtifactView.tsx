import React, { useEffect, useState } from "react";
import { apiUrl, authHeaders } from "../../connection";
import { emptyBody, emptyTitle, ghostBtn } from "./workspaceChrome";

export function ArtifactView({
  name,
  content: provided,
}: {
  name: string;
  content?: string | null;
}) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const isMd = ext === "md" || ext === "markdown";
  const isHtml = ext === "html" || ext === "htm";
  const isImage = ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext);
  const [mode, setMode] = useState<"render" | "raw">(isHtml || isMd || isImage ? "render" : "raw");
  const [fit, setFit] = useState(true);
  const [loaded, setLoaded] = useState<string | null>(provided ?? null);

  useEffect(() => {
    if (provided) {
      setLoaded(provided);
      return;
    }
    if (!name) return;
    let cancelled = false;
    const base = name.replace(/\\/g, "/").split("/").pop() || name;
    void fetch(apiUrl("/files"), { headers: authHeaders() })
      .then((r) => r.json())
      .then(async (tree) => {
        const files = (tree.locations ?? []).flatMap((l: { files?: Array<{ id?: string; name?: string; path?: string }> }) => l.files ?? []);
        const hit = files.find((f: { id?: string; name?: string; path?: string }) => f.path === name || f.name === name || f.name === base);
        const q = hit?.id
          ? `/files/read?id=${encodeURIComponent(hit.id)}`
          : `/files/read?path=${encodeURIComponent(name)}`;
        const d = await fetch(apiUrl(q), { headers: authHeaders() }).then((r) => r.json());
        if (cancelled) return;
        if (d.dataUrl) setLoaded(d.dataUrl);
        else if (d.content) setLoaded(String(d.content));
        else if (window.orvyn?.project?.readFile) {
          const text = await window.orvyn.project.readFile(name);
          if (!cancelled) setLoaded(text);
        }
      })
      .catch(() => {
        if (cancelled) return;
        if (window.orvyn?.project?.readFile) {
          void window.orvyn.project.readFile(name).then(
            (text) => { if (!cancelled) setLoaded(text); },
            () => { if (!cancelled) setLoaded(null); }
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [name, provided]);

  const content = loaded;

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
        {isImage && (
          <button style={ghostBtn()} onClick={() => setFit((v) => !v)}>
            {fit ? "100%" : "Fit"}
          </button>
        )}
      </div>
      {isImage && content ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto", padding: 16 }}>
          <img src={content} alt={name} style={fit ? { maxWidth: "100%", maxHeight: "100%" } : { transform: "scale(1.4)", transformOrigin: "center" }} />
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
