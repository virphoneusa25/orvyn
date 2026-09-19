// apps/desktop/src/renderer/components/AgentComposer.tsx
//
// The input area for Chat and Agent: searchable mode/skills picker
// (Plan / Debug / Multitask / Ask / Agent), file + image attachments,
// and RAG. The menu is clamped inside the panel so it cannot paint off-screen.
import React, { useEffect, useRef, useState } from "react";
import { apiUrl, authHeaders } from "../connection";
import { IconFile, IconClose, IconSparkles, IconSearch, IconImage } from "./Icons";
import { fileToAttachment } from "./AttachmentBar";

export interface Attachment {
  kind: "file" | "image";
  name: string;
  content?: string;
  b64?: string;
  mediaType?: string;
}

export interface AgentModeInfo {
  id: string;
  label: string;
  description: string;
  toolsEnabled: boolean;
}

const MODE_COLOR: Record<string, string> = {
  plan: "#E8B93F",
  debug: "#F0546A",
  multitask: "#A9B4FF",
  ask: "#3FD68A",
  agent: "#5B6CFF",
};

const FALLBACK_MODES: AgentModeInfo[] = [
  { id: "agent", label: "Agent", description: "Full access — reads, edits, and runs commands with approval", toolsEnabled: true },
  { id: "plan", label: "Plan", description: "Generate an implementation plan — investigates but never edits", toolsEnabled: true },
  { id: "debug", label: "Debug", description: "Pinpoint the root cause of an issue", toolsEnabled: true },
  { id: "multitask", label: "Multitask", description: "Orchestrate subagents: planner decomposes, executor works, reviewer checks", toolsEnabled: true },
  { id: "ask", label: "Ask", description: "Answer questions without making edits", toolsEnabled: false },
];

const SKILLS: { id: string; mode?: string; label: string; description: string }[] = [
  { id: "debug", mode: "debug", label: "Debug", description: "Find the root cause — no silent fixes" },
  { id: "plan", mode: "plan", label: "Plan", description: "Investigate and plan, never edit" },
  { id: "multitask", mode: "multitask", label: "Multitask", description: "Planner → executor → reviewer" },
  { id: "review", mode: "ask", label: "Review", description: "Read-only answers and code review" },
  { id: "image", label: "Generate image", description: "Just ask: “draw a logo of a phone…”" },
];

export function AgentComposer({
  value,
  onChange,
  onSubmit,
  mode,
  onModeChange,
  attachments,
  onAttachmentsChange,
  disabled,
  models,
  activeModel,
  onModelChange,
  useRag,
  onUseRagChange,
  ragEnabled = true,
  submitLabel = "Send",
  placeholder,
  onSkill,
  compact,
  hideModeDescription,
  onTextKeyDown,
  busy,
  onStop,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  mode: string;
  onModeChange: (m: string) => void;
  attachments: Attachment[];
  onAttachmentsChange: (a: Attachment[]) => void;
  disabled?: boolean;
  models?: { id: string; name: string }[];
  activeModel?: string;
  onModelChange?: (id: string) => void;
  useRag?: boolean;
  onUseRagChange?: (v: boolean) => void;
  ragEnabled?: boolean;
  submitLabel?: string;
  placeholder?: string;
  onSkill?: (id: string) => void;
  compact?: boolean;
  hideModeDescription?: boolean;
  onTextKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean | void;
  /** A run is in flight: the send button becomes Stop. */
  busy?: boolean;
  onStop?: () => void;
}) {
  const stoppable = Boolean(busy && onStop);
  const [modes, setModes] = useState<AgentModeInfo[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  useEffect(() => {
    fetch(apiUrl("/agent/modes"), { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => setModes(d.modes ?? FALLBACK_MODES))
      .catch(() => setModes(FALLBACK_MODES));
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  async function addFiles(list: FileList | File[] | null) {
    if (!list) return;
    const next = [...attachmentsRef.current];
    for (const file of Array.from(list)) {
      const a = await fileToAttachment(file);
      if (a) next.push(a);
    }
    onAttachmentsChange(next);
  }

  useEffect(() => {
    async function onPaste(e: ClipboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".monaco-editor, .monaco-diff-editor")) return;
      const items = Array.from(e.clipboardData?.items ?? []);
      const images = items.filter((i) => i.type.startsWith("image/"));
      if (images.length === 0) return;
      const files = images.map((i) => i.getAsFile()).filter(Boolean) as File[];
      if (files.length) await addFiles(files);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [onAttachmentsChange]);

  const current = modes.find((m) => m.id === mode) ?? FALLBACK_MODES.find((m) => m.id === mode);
  const q = filter.toLowerCase();
  const shownModes = modes.filter(
    (m) => !q || m.label.toLowerCase().includes(q) || m.description.toLowerCase().includes(q)
  );
  const shownSkills = SKILLS.filter(
    (s) => !q || s.label.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.id.includes(q)
  );

  return (
    <div
      style={{
        borderTop: compact ? "none" : "1px solid var(--border)",
        padding: compact ? 0 : 10,
        position: "relative",
        minWidth: 0,
        overflow: "visible",
        zIndex: menuOpen ? 40 : 1,
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void addFiles(e.dataTransfer.files);
      }}
    >
      {menuOpen && (
        <div
          ref={menuRef}
          style={{
            position: "absolute",
            bottom: "100%",
            left: compact ? 0 : 8,
            right: compact ? 0 : 8,
            width: "auto",
            maxWidth: "100%",
            minWidth: 0,
            boxSizing: "border-box",
            marginBottom: 6,
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-strong)",
            borderRadius: 8,
            boxShadow: "0 16px 40px rgba(0,0,0,0.6)",
            zIndex: 80,
            overflow: "hidden",
            maxHeight: "min(320px, 45vh)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search modes, skills, files…"
            style={{
              width: "100%",
              background: "transparent",
              border: "none",
              borderBottom: "1px solid var(--border)",
              color: "var(--text)",
              padding: "9px 12px",
              fontSize: 13,
              outline: "none",
              boxSizing: "border-box",
              flexShrink: 0,
            }}
          />
          <div style={{ overflowY: "auto", overflowX: "hidden", padding: 4, minHeight: 0 }}>
            {shownModes.map((m) => (
              <button
                key={m.id}
                onClick={() => {
                  onModeChange(m.id);
                  setMenuOpen(false);
                  setFilter("");
                }}
                style={rowBtn(mode === m.id)}
              >
                <span style={{ color: MODE_COLOR[m.id] ?? "var(--text-muted)", display: "flex", flexShrink: 0 }}>
                  {m.id === "debug" ? <IconSearch size={14} /> : <IconSparkles size={14} />}
                </span>
                <span style={{ fontWeight: 500, flexShrink: 0 }}>{m.label}</span>
                <span style={descStyle()}>{m.description}</span>
                {!m.toolsEnabled && (
                  <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>no tools</span>
                )}
              </button>
            ))}

            {shownSkills.length > 0 && (
              <>
                <div style={{ fontSize: 10, color: "var(--text-muted)", letterSpacing: 0.5, padding: "8px 9px 4px", textTransform: "uppercase" }}>
                  Skills
                </div>
                {shownSkills.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => {
                      if (s.mode) onModeChange(s.mode);
                      onSkill?.(s.id);
                      setMenuOpen(false);
                      setFilter("");
                    }}
                    style={rowBtn(false)}
                  >
                    <span style={{ color: "var(--text-muted)", display: "flex", flexShrink: 0 }}>
                      {s.id === "image" ? <IconImage size={14} /> : s.id === "debug" ? <IconSearch size={14} /> : <IconSparkles size={14} />}
                    </span>
                    <span style={{ fontWeight: 500, flexShrink: 0 }}>{s.label}</span>
                    <span style={descStyle()}>{s.description}</span>
                  </button>
                ))}
              </>
            )}

            <div style={{ height: 1, background: "var(--border)", margin: "4px 6px" }} />

            <button
              onClick={() => {
                fileRef.current?.click();
                setMenuOpen(false);
              }}
              style={rowBtn(false)}
            >
              <IconFile size={14} />
              <span style={{ flexShrink: 0 }}>Files &amp; images</span>
              <span style={descStyle()}>attach as reference, or to review/edit</span>
            </button>

            {onUseRagChange && (
              <button
                onClick={() => onUseRagChange(!useRag)}
                style={rowBtn(!!useRag)}
                disabled={!ragEnabled}
              >
                <IconSearch size={14} />
                <span style={{ flexShrink: 0 }}>RAG</span>
                <span style={descStyle()}>
                  {ragEnabled ? (useRag ? "On — search the codebase index" : "Off — current file and attachments only") : "Open a folder to enable"}
                </span>
              </button>
            )}

            {models && models.length > 0 && onModelChange && (
              <div style={{ padding: "6px 9px", display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <IconSparkles size={14} />
                <span style={{ fontSize: 12.5, flexShrink: 0 }}>Model</span>
                <select
                  value={activeModel ?? ""}
                  onChange={(e) => onModelChange(e.target.value)}
                  style={{
                    marginLeft: "auto",
                    minWidth: 0,
                    maxWidth: "55%",
                    background: "var(--bg-app)",
                    border: "1px solid var(--border)",
                    borderRadius: 5,
                    color: "var(--text)",
                    fontSize: 12,
                    padding: "3px 6px",
                  }}
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          void addFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {attachments.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 7, minWidth: 0 }}>
          {attachments.map((a, i) => (
            <span
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                background: "var(--bg-elevated)",
                border: "1px solid var(--border)",
                borderRadius: 5,
                padding: "2px 6px",
                fontSize: 11.5,
                maxWidth: "100%",
              }}
            >
              {a.kind === "image" ? "🖼" : <IconFile size={11} />}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
              <button
                onClick={() => onAttachmentsChange(attachments.filter((_, j) => j !== i))}
                style={{ background: "transparent", border: "none", color: "var(--text-muted)", display: "flex", padding: 0 }}
              >
                <IconClose size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, minWidth: 0 }}>
        <button onClick={() => setMenuOpen((o) => !o)} style={modeChip(MODE_COLOR[mode] ?? "var(--accent)")}>
          {current?.label ?? "Agent"} ▾
        </button>
        {current && !hideModeDescription && (
          <span
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            {current.description}
          </span>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, minWidth: 0 }}>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (onTextKeyDown?.(e)) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          rows={2}
          disabled={disabled}
          placeholder={placeholder ?? "Describe the task — Enter to send, Shift+Enter for a new line"}
          style={{
            flex: 1,
            minWidth: 0,
            background: "var(--bg-app)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            color: "var(--text)",
            padding: "7px 10px",
            fontSize: 13,
            resize: "vertical",
            fontFamily: "inherit",
          }}
        />
        {/* While a run is live the primary action is to stop it. Leaving a
            disabled Send there gives the user nothing to press and no way out. */}
        {stoppable ? (
          <button
            onClick={onStop}
            title="Stop the current run"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: "transparent",
              border: "1px solid var(--danger)",
              borderRadius: 6,
              color: "var(--danger)",
              padding: "0 16px",
              fontSize: 12.5,
              flexShrink: 0,
              cursor: "pointer",
            }}
          >
            <span style={{ width: 9, height: 9, background: "var(--danger)", borderRadius: 2, display: "inline-block" }} />
            Stop
          </button>
        ) : (
          <button
            onClick={onSubmit}
            disabled={disabled}
            style={{
              background: "var(--accent)",
              border: "none",
              borderRadius: 6,
              color: "var(--accent-fg)",
              padding: "0 16px",
              fontSize: 12.5,
              flexShrink: 0,
              opacity: disabled ? 0.5 : 1,
            }}
          >
            {submitLabel}
          </button>
        )}
      </div>
    </div>
  );
}

function descStyle(): React.CSSProperties {
  return {
    color: "var(--text-muted)",
    fontSize: 11.5,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
    flex: 1,
  };
}

function rowBtn(active: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 9,
    width: "100%",
    minWidth: 0,
    overflow: "hidden",
    background: active ? "var(--bg-active)" : "transparent",
    border: "none",
    color: "var(--text)",
    padding: "6px 9px",
    fontSize: 12.5,
    borderRadius: 5,
    textAlign: "left",
  };
}

function modeChip(color: string): React.CSSProperties {
  return {
    background: "transparent",
    border: `1px solid ${color}66`,
    color,
    borderRadius: 5,
    padding: "3px 9px",
    fontSize: 11.5,
    fontWeight: 500,
    flexShrink: 0,
  };
}
