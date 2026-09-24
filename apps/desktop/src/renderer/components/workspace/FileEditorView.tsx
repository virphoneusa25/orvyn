import React, { useEffect, useState } from "react";
import Editor from "@monaco-editor/react";
import { apiUrl, authHeaders } from "../../connection";
import { isFabricatedGeneratedPath, userFacingFileError } from "../../workbenchFileAccess";
import { ArtifactView } from "./ArtifactView";
import { emptyBody, emptyTitle } from "./workspaceChrome";

export function guessLanguage(path: string): string {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    py: "python",
    rs: "rust",
    go: "go",
    yml: "yaml",
    yaml: "yaml",
    htm: "html",
    php: "php",
    sh: "shell",
    bash: "shell",
    ps1: "powershell",
    xml: "xml",
    svg: "xml",
    sql: "sql",
    scss: "scss",
    less: "less",
    java: "java",
    cs: "csharp",
    c: "c",
    cpp: "cpp",
    h: "cpp",
    rb: "ruby",
    ini: "ini",
    env: "ini",
    toml: "ini",
    mjs: "javascript",
    cjs: "javascript",
    dockerfile: "dockerfile",
  };
  return map[ext] ?? "plaintext";
}

export function FileEditorView({ path }: { path?: string | null }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!path) {
      setContent(null);
      setError(null);
      return;
    }
    if (isFabricatedGeneratedPath(path)) {
      setContent(null);
      setError("This generated file is an artifact. Open it from Files.");
      return;
    }
    setError(null);
    void window.orvyn.project.readFile(path).then(
      (text) => {
        if (!cancelled) setContent(text);
      },
      (err: Error) => {
        if (!cancelled) setError(userFacingFileError(err));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (path && isFabricatedGeneratedPath(path)) {
    return <GeneratedArtifactPane path={path} />;
  }

  if (!path) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 28, gap: 8, textAlign: "center" }}>
        <div style={emptyTitle()}>No file open</div>
        <div style={emptyBody()}>Select a workspace file from Files.</div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "6px 12px", borderBottom: "1px solid var(--orvyn-border-soft)", fontSize: 11, color: "var(--orvyn-text-muted)" }}>
        {path} · {guessLanguage(path)} · read-only
      </div>
      {error ? (
        <div style={{ padding: 16, color: "var(--orvyn-text-secondary)" }}>{error}</div>
      ) : content == null ? (
        <div style={{ padding: 16, color: "var(--orvyn-text-muted)" }}>Loading…</div>
      ) : (
        <Editor
          height="100%"
          theme="orvyn-dark"
          path={path}
          language={guessLanguage(path)}
          value={content}
          options={{
            readOnly: true,
            fontSize: 13,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            lineNumbers: "on",
          }}
        />
      )}
    </div>
  );
}

function GeneratedArtifactPane({ path }: { path: string }) {
  const name = path.replace(/\\/g, "/").split("/").pop() || path;
  const [artifactId, setArtifactId] = useState<string | undefined>();
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setArtifactId(undefined);
    setMissing(false);
    fetch(apiUrl(`/artifacts?q=${encodeURIComponent(name)}`), { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const rows = Array.isArray(d.artifacts) ? d.artifacts : [];
        const hit = rows.find((a: { name?: string; artifactId?: string }) => a.name === name) ?? rows[0];
        if (hit?.artifactId) setArtifactId(String(hit.artifactId));
        else setMissing(true);
      })
      .catch(() => {
        if (!cancelled) setMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [name]);

  if (missing) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 28, gap: 8, textAlign: "center" }}>
        <div style={emptyTitle()}>Artifact unavailable</div>
        <div style={emptyBody()}>{name} is a generated file. ORVYN will not open it as a project file.</div>
      </div>
    );
  }
  if (!artifactId) {
    return <div style={{ padding: 16, color: "var(--orvyn-text-muted)" }}>Loading {name}…</div>;
  }
  return <ArtifactView name={name} artifactId={artifactId} />;
}
