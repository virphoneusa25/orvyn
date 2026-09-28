import React, { useEffect, useState } from "react";
import Editor from "@monaco-editor/react";
import { apiUrl, authHeaders } from "../../connection";
import { previewKind, userFacingFileError } from "../../workbenchFileAccess";
import { emptyBody, emptyTitle, ghostBtn } from "./workspaceChrome";
import { FileTypeIcon } from "../FileTypeIcon";
import { guessLanguage } from "./codeLanguage.ts";

/** Above this, tokenizing would stall the pane: render plain text instead. */
const MAX_HIGHLIGHT_BYTES = 1_500_000;

export function ArtifactView({
  name,
  artifactId,
}: {
  name: string;
  artifactId?: string;
}) {
  const [loaded, setLoaded] = useState<{ url?: string; text?: string; mime?: string; error?: string } | null>(null);
  const [fit, setFit] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);

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

  const copy = async () => {
    if (!loaded?.text) return;
    try {
      await navigator.clipboard.writeText(loaded.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard unavailable */ }
  };

  const tooBig = (loaded?.text?.length ?? 0) > MAX_HIGHLIGHT_BYTES;

  return (
    <div data-testid="workbench-artifact" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--orvyn-border-soft)" }}>
        <FileTypeIcon path={name} size={16} />
        <code style={{ flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</code>
        <span style={{ fontSize: 10, color: "var(--orvyn-cyan)" }}>GENERATED</span>
        {kind === "image" && (
          <button style={ghostBtn()} onClick={() => setFit((v) => !v)}>
            {fit ? "100%" : "Fit"}
          </button>
        )}
        {kind === "text" && !!loaded?.text && !tooBig && (
          <>
            <button style={ghostBtn()} onClick={() => setWrap((v) => !v)} title="Toggle word wrap">
              {wrap ? "No wrap" : "Wrap"}
            </button>
            <button style={ghostBtn()} onClick={() => void copy()} title="Copy the original source">
              {copied ? "Copied ✓" : "Copy"}
            </button>
          </>
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
        // The SAME Monaco engine the Code view and Diff inspector use
        // (theme "orvyn-dark"), read-only: real tokenizer-driven syntax
        // highlighting for CSS/HTML/JS/TS/JSON/MD/Python/Go/Rust/... — not
        // regex coloring, and no raw innerHTML of untrusted source.
        tooBig ? (
          <pre style={{ flex: 1, overflow: "auto", margin: 0, padding: 12, whiteSpace: wrap ? "pre-wrap" : "pre", fontSize: 12, lineHeight: 1.6 }}>
            {loaded.text}
          </pre>
        ) : (
          <Editor
            height="100%"
            theme="orvyn-dark"
            path={`orvyn-artifact/${name}`}
            language={guessLanguage(name)}
            value={loaded.text}
            options={{
              readOnly: true,
              domReadOnly: true,
              minimap: { enabled: false },
              fontSize: 12.5,
              fontFamily: "JetBrains Mono, Geist Mono, Cascadia Code, Consolas, monospace",
              lineNumbers: "on",
              renderLineHighlight: "none",
              scrollBeyondLastLine: false,
              automaticLayout: true,
              wordWrap: wrap ? "on" : "off",
              scrollbar: { alwaysConsumeMouseWheel: false, horizontal: "auto", vertical: "auto" },
              overviewRulerLanes: 0,
              guides: { indentation: false },
              padding: { top: 8 },
              stickyScroll: { enabled: false },
            }}
          />
        )
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
