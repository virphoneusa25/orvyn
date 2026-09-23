import React, { useEffect, useState } from "react";
import { apiUrl, authHeaders } from "../../connection";
import { previewKind, userFacingFileError } from "../../workbenchFileAccess";
import { emptyBody, emptyTitle, ghostBtn } from "./workspaceChrome";

export function ArtifactView({
  name,
  artifactId,
}: {
  name: string;
  artifactId?: string;
}) {
  const [loaded, setLoaded] = useState<{ url?: string; text?: string; mime?: string; error?: string } | null>(null);
  const [fit, setFit] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    if (!artifactId) {
      setLoaded({ error: "Artifact unavailable" });
      return;
    }
    void fetch(apiUrl(`/files/read?id=${encodeURIComponent(artifactId)}`), { headers: authHeaders() })
      .then(async (r) => {
        const d = await r.json();
        if (cancelled) return;
        if (!r.ok) {
          setLoaded({ error: userFacingFileError(d.error || "Artifact unavailable") });
          return;
        }
        setLoaded({
          url: d.dataUrl,
          text: typeof d.content === "string" ? d.content : undefined,
          mime: d.artifact?.mimeType ?? d.artifact?.mediaType,
        });
      })
      .catch((err) => {
        if (!cancelled) setLoaded({ error: userFacingFileError(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId]);

  const kind = previewKind(loaded?.mime, name);

  if (!name && !artifactId) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 28, gap: 8, textAlign: "center" }}>
        <div style={emptyTitle()}>No artifact selected</div>
        <div style={emptyBody()}>Created files appear in Files → Generated.</div>
      </div>
    );
  }

  return (
    <div data-testid="workbench-artifact" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--orvyn-border-soft)" }}>
        <code style={{ flex: 1, fontSize: 12 }}>{name}</code>
        <span style={{ fontSize: 10, color: "var(--orvyn-cyan)" }}>GENERATED</span>
        {kind === "image" && (
          <button style={ghostBtn()} onClick={() => setFit((v) => !v)}>
            {fit ? "100%" : "Fit"}
          </button>
        )}
      </div>
      {loaded?.error ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center", gap: 8 }}>
          <div style={emptyTitle()}>{loaded.error}</div>
          <div style={emptyBody()}>ORVYN will not look this up as a project file.</div>
        </div>
      ) : kind === "image" && loaded?.url ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto", padding: 16 }}>
          <img src={loaded.url} alt={name} style={fit ? { maxWidth: "100%", maxHeight: "100%" } : { transform: "scale(1.4)", transformOrigin: "center" }} />
        </div>
      ) : kind === "text" && loaded?.text ? (
        <pre style={{ flex: 1, overflow: "auto", margin: 0, padding: 12, whiteSpace: "pre-wrap", fontSize: 12, lineHeight: 1.6 }}>{loaded.text}</pre>
      ) : loaded == null ? (
        <div style={{ padding: 16, color: "var(--orvyn-text-muted)" }}>Loading…</div>
      ) : (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--orvyn-text-muted)" }}>
          Download this artifact from Files.
        </div>
      )}
    </div>
  );
}
