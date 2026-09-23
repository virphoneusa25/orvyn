import React, { useEffect, useState } from "react";
import Editor from "@monaco-editor/react";
import { isFabricatedGeneratedPath, userFacingFileError } from "../../workbenchFileAccess";
import { emptyBody, emptyTitle } from "./workspaceChrome";

function guessLanguage(path: string): string {
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
