// apps/desktop/src/renderer/components/InlineEdit.tsx
//
// Ctrl+K. Opens over the editor with the current selection, takes a plain
// language instruction, shows the proposed rewrite as a diff, and lets the user
// accept or reject. Nothing is written until Accept is pressed.
import React, { useState, useRef, useEffect } from "react";
import { apiUrl, authHeaders } from "../connection";
import { IconCheck, IconClose } from "./Icons";

interface DiffLine {
  type: "context" | "add" | "remove";
  content: string;
}

interface EditResult {
  original: string;
  edited: string;
  diff: DiffLine[];
  additions: number;
  deletions: number;
}

export function InlineEdit({
  selection,
  filePath,
  fileContent,
  language,
  onAccept,
  onClose,
}: {
  selection: string;
  filePath?: string;
  fileContent?: string;
  language?: string;
  onAccept: (newText: string) => void;
  onClose: () => void;
}) {
  const [instruction, setInstruction] = useState("");
  const [result, setResult] = useState<EditResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Esc always closes, even mid-request — a stuck overlay over the editor is
  // far worse than a wasted request.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function run() {
    if (!instruction.trim()) {
      setError("Describe the change you want first.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiUrl("/edit/inline"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ selection, instruction, filePath, fileContent, language }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Edit failed");
      setResult(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        left: "50%",
        transform: "translateX(-50%)",
        width: "min(720px, 92%)",
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
        zIndex: 50,
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: 10 }}>
        <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>Ctrl+K</span>
        <input
          ref={inputRef}
          value={instruction}
          onChange={(e) => {
            setInstruction(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              run();
            }
          }}
          placeholder="Describe the change — e.g. convert to async/await, add error handling…"
          style={{
            flex: 1,
            background: "var(--bg-app)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            color: "var(--text)",
            padding: "7px 10px",
            fontSize: 13,
          }}
        />
        <button onClick={run} disabled={loading} style={primaryBtn()}>
          {loading ? "Working…" : "Generate"}
        </button>
        <button onClick={onClose} aria-label="Close" style={iconBtn()}>
          <IconClose size={14} />
        </button>
      </div>

      {error && (
        <div style={{ padding: "0 10px 10px", fontSize: 12, color: "var(--danger)" }}>{error}</div>
      )}

      {result && (
        <>
          <div
            style={{
              maxHeight: 320,
              overflowY: "auto",
              borderTop: "1px solid var(--border)",
              fontFamily: "var(--font-mono)",
              fontSize: 12.5,
              lineHeight: 1.55,
            }}
          >
            {result.diff.map((line, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  background:
                    line.type === "add" ? "rgba(63,214,138,0.10)" : line.type === "remove" ? "rgba(240,84,106,0.10)" : "transparent",
                  color:
                    line.type === "add" ? "#8FE8BC" : line.type === "remove" ? "#FF9AA8" : "var(--text-secondary)",
                }}
              >
                <span style={{ width: 22, textAlign: "center", flexShrink: 0, opacity: 0.6 }}>
                  {line.type === "add" ? "+" : line.type === "remove" ? "-" : ""}
                </span>
                <span className="selectable" style={{ whiteSpace: "pre-wrap", flex: 1, paddingRight: 10 }}>
                  {line.content || " "}
                </span>
              </div>
            ))}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: 10,
              borderTop: "1px solid var(--border)",
            }}
          >
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              <span style={{ color: "var(--success)" }}>+{result.additions}</span>{" "}
              <span style={{ color: "var(--danger)" }}>−{result.deletions}</span>
            </span>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button onClick={onClose} style={ghostBtn()}>
                Reject
              </button>
              <button
                onClick={() => {
                  onAccept(result.edited);
                  onClose();
                }}
                style={{ ...primaryBtn(), display: "flex", alignItems: "center", gap: 5 }}
              >
                <IconCheck size={13} /> Accept
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function primaryBtn(): React.CSSProperties {
  return {
    background: "var(--accent)",
    border: "none",
    borderRadius: "var(--radius)",
    color: "var(--accent-fg)",
    padding: "6px 13px",
    fontSize: 12.5,
  };
}
function ghostBtn(): React.CSSProperties {
  return {
    background: "transparent",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius)",
    color: "var(--text-secondary)",
    padding: "6px 13px",
    fontSize: 12.5,
  };
}
function iconBtn(): React.CSSProperties {
  return {
    background: "transparent",
    border: "none",
    color: "var(--text-muted)",
    padding: 5,
    display: "flex",
    alignItems: "center",
  };
}
