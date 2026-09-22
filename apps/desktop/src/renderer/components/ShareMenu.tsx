import React, { useEffect, useRef, useState } from "react";
import {
  buildDiagnostics,
  buildJsonTranscript,
  buildMarkdownTranscript,
  type TranscriptInput,
} from "../shareTranscript";
import { IconCopy, IconFile } from "./Icons";

export function ShareMenu({
  open,
  onClose,
  transcript,
  diagnostics,
}: {
  open: boolean;
  onClose: () => void;
  transcript: TranscriptInput;
  diagnostics: { runId?: string | null; backendHost?: string; workspaceName?: string | null; engineState?: string; cloudMode?: boolean };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      setNote(null);
      setExportOpen(false);
      return;
    }
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  async function copy(text: string, label: string) {
    try {
      if (window.orvyn.window.writeClipboard) await window.orvyn.window.writeClipboard(text);
      else await navigator.clipboard.writeText(text);
      setNote(`${label} copied`);
    } catch {
      setNote("Could not copy");
    }
  }

  async function exportTranscript(format: "md" | "json") {
    const content = format === "md" ? buildMarkdownTranscript(transcript) : buildJsonTranscript(transcript);
    const defaultName = `orvyn-transcript.${format === "md" ? "md" : "json"}`;
    try {
      const result = await window.orvyn.window.saveText({ defaultName, content });
      setNote(result.ok ? "Transcript saved" : result.canceled ? "Save canceled" : "Could not save");
    } catch {
      setNote("Could not save");
    }
    setExportOpen(false);
  }

  return (
    <div
      ref={ref}
      role="menu"
      className="no-drag"
      style={{
        position: "absolute",
        top: 36,
        right: 0,
        width: 260,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-strong)",
        borderRadius: 8,
        boxShadow: "var(--orvyn-shadow)",
        padding: 6,
        zIndex: 700,
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 650, padding: "6px 8px 4px", color: "var(--orvyn-text-muted)", letterSpacing: 0.4 }}>
        SHARE
      </div>
      <MenuRow icon={<IconCopy size={13} />} label="Copy conversation" onClick={() => void copy(buildMarkdownTranscript(transcript), "Conversation")} />
      <MenuRow
        icon={<IconCopy size={13} />}
        label="Copy Run ID"
        disabled={!transcript.runId}
        onClick={() => transcript.runId && void copy(transcript.runId, "Run ID")}
      />
      <MenuRow icon={<IconFile size={13} />} label="Export transcript" onClick={() => setExportOpen((v) => !v)} />
      {exportOpen && (
        <div style={{ padding: "0 8px 6px 28px", display: "flex", gap: 6 }}>
          <button type="button" onClick={() => void exportTranscript("md")} style={miniBtn}>
            Markdown
          </button>
          <button type="button" onClick={() => void exportTranscript("json")} style={miniBtn}>
            JSON
          </button>
        </div>
      )}
      <MenuRow
        icon={<IconCopy size={13} />}
        label="Copy diagnostics"
        onClick={() => void copy(buildDiagnostics({ ...diagnostics, runId: transcript.runId }), "Diagnostics")}
      />
      <div style={{ fontSize: 10, color: "var(--orvyn-text-muted)", padding: "6px 8px 4px", lineHeight: 1.45 }}>
        Public share links are not available yet. Secrets and hidden reasoning are never copied.
      </div>
      {note && <div style={{ fontSize: 11, color: "var(--orvyn-cyan)", padding: "0 8px 6px" }}>{note}</div>}
    </div>
  );
}

function MenuRow({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        background: "transparent",
        border: "none",
        color: disabled ? "var(--text-muted)" : "var(--orvyn-text)",
        padding: "7px 8px",
        fontSize: 12.5,
        borderRadius: 6,
        textAlign: "left",
        cursor: disabled ? "default" : "pointer",
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      <span style={{ color: "var(--orvyn-text-muted)", display: "inline-flex" }}>{icon}</span>
      {label}
    </button>
  );
}

const miniBtn: React.CSSProperties = {
  background: "var(--orvyn-surface-2)",
  border: "1px solid var(--orvyn-border)",
  borderRadius: 5,
  color: "var(--orvyn-text-secondary)",
  fontSize: 11,
  padding: "3px 8px",
  cursor: "pointer",
};
