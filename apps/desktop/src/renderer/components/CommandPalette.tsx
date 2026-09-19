import React, { useEffect, useMemo, useRef, useState } from "react";

export type PaletteMode = "files" | "commands";

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette({
  mode,
  files,
  commands,
  onOpenFile,
  onClose,
}: {
  mode: PaletteMode;
  files: string[];
  commands: PaletteCommand[];
  onOpenFile: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (mode === "files") {
      const list = q ? files.filter((f) => f.toLowerCase().includes(q)) : files;
      return list.slice(0, 80).map((path) => ({ id: path, label: path.split(/[\\/]/).pop() ?? path, hint: path }));
    }
    const list = q
      ? commands.filter((c) => `${c.label} ${c.hint ?? ""}`.toLowerCase().includes(q))
      : commands;
    return list.map((c) => ({ id: c.id, label: c.label, hint: c.hint }));
  }, [mode, files, commands, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    setActive(0);
  }, [query, mode]);

  function choose(index: number) {
    const item = items[index];
    if (!item) return;
    if (mode === "files") onOpenFile(item.id);
    else commands.find((c) => c.id === item.id)?.run();
    onClose();
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(8,10,15,0.55)",
        zIndex: 50,
        display: "flex",
        justifyContent: "center",
        paddingTop: 80,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxWidth: "92vw",
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-strong)",
          borderRadius: 10,
          boxShadow: "0 24px 80px rgba(0,0,0,0.45)",
          overflow: "hidden",
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((n) => Math.min(items.length - 1, n + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((n) => Math.max(0, n - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(active);
            }
          }}
          placeholder={mode === "files" ? "Go to file…" : "Run a command…"}
          style={{
            width: "100%",
            background: "transparent",
            border: "none",
            borderBottom: "1px solid var(--border)",
            color: "var(--text)",
            padding: "14px 16px",
            fontSize: 14,
            outline: "none",
            fontFamily: "inherit",
          }}
        />
        <div style={{ maxHeight: 360, overflowY: "auto", padding: 6 }}>
          {items.length === 0 && (
            <div style={{ padding: "12px 10px", fontSize: 13, color: "var(--text-muted)" }}>No matches</div>
          )}
          {items.map((item, i) => (
            <button
              key={item.id}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(i)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                background: i === active ? "var(--bg-active)" : "transparent",
                border: "none",
                borderRadius: 6,
                color: "var(--text)",
                padding: "8px 10px",
                cursor: "pointer",
              }}
            >
              <div style={{ fontSize: 13 }}>{item.label}</div>
              {item.hint && item.hint !== item.label && (
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{item.hint}</div>
              )}
            </button>
          ))}
        </div>
        <div style={{ padding: "6px 12px", fontSize: 11, color: "var(--text-muted)", borderTop: "1px solid var(--border)" }}>
          {mode === "files" ? "Ctrl+P · files" : "Ctrl+Shift+P · commands"} · Esc to close
        </div>
      </div>
    </div>
  );
}
