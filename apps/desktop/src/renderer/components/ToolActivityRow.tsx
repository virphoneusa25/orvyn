// apps/desktop/src/renderer/components/ToolActivityRow.tsx
//
// The compact tool row of the center work stream — the spec's target shape:
//
//   [icon] Read   TS   session.ts   src/auth/          ✓
//   [icon] Terminal     npm run typecheck              ✓
//
// 28–34px tall, inline with the conversation, status updates IN PLACE
// (one row per callId, never one row per lifecycle event). Clicking a row
// with a context target opens + pins the matching right-panel tab.

import React, { useState } from "react";
import { GroupItem, ToolItem, ToolOp } from "../presentationReducer";
import { IconFile, IconSearch, IconTerminal, IconGlobe, IconWrench, IconCode, IconZap } from "./Icons";

const OP_LABEL: Record<ToolOp, string> = {
  read: "Read",
  create: "Create",
  edit: "Edit",
  delete: "Delete",
  search: "Search",
  terminal: "Terminal",
  browser: "Browser",
  git: "Git",
  test: "Test",
  other: "Run",
};

const EXT_COLOR: Record<string, string> = {
  TS: "#6C5CFF",
  TSX: "#6C5CFF",
  JS: "#F5B942",
  JSX: "#F5B942",
  JSON: "#F5B942",
  CSS: "#22D3EE",
  SCSS: "#22D3EE",
  HTML: "#F25F75",
  MD: "#8fa3b8",
  PY: "#20D89B",
  GO: "#22D3EE",
  RS: "#F25F75",
  JAVA: "#F25F75",
  CS: "#4DA3FF",
  CPP: "#4DA3FF",
  YML: "#8fa3b8",
  YAML: "#8fa3b8",
  XML: "#8fa3b8",
  SQL: "#F5B942",
  ENV: "#F5B942",
};

function opIcon(op: ToolOp, color: string, size = 13) {
  const wrap = (el: React.ReactNode) => <span style={{ color, display: "inline-flex", flexShrink: 0 }}>{el}</span>;
  switch (op) {
    case "terminal":
      return wrap(<IconTerminal size={size} />);
    case "search":
      return wrap(<IconSearch size={size} />);
    case "browser":
      return wrap(<IconGlobe size={size} />);
    case "edit":
    case "create":
    case "delete":
      return wrap(<IconWrench size={size} />);
    case "git":
      return wrap(<IconCode size={size} />);
    case "test":
      return wrap(<IconZap size={size} />);
    default:
      return wrap(<IconFile size={size} />);
  }
}

export function ToolActivityRow({ item }: { item: ToolItem }) {
  const color = item.op === "terminal" ? "var(--accent)" : item.op === "edit" || item.op === "create" ? "var(--success)" : "var(--text-muted)";
  const clickable = Boolean(item.ctx);
  return (
    <div
      onClick={clickable ? () => document.dispatchEvent(new CustomEvent("orvyn:context-tab", { detail: { tab: item.ctx, pin: true } })) : undefined}
      title={item.error ?? (clickable ? "Open in the right panel" : undefined)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        height: 30,
        padding: "0 10px",
        margin: "2px 0",
        borderRadius: 6,
        background: "rgba(255,255,255,0.02)",
        border: "1px solid var(--border-soft, rgba(255,255,255,0.06))",
        cursor: clickable ? "pointer" : "default",
        minWidth: 0,
        fontSize: 12,
      }}
    >
      <span style={{ color, display: "inline-flex", flexShrink: 0 }}>{opIcon(item.op, color)}</span>
      <span style={{ width: 56, flexShrink: 0, color: "var(--text-muted)", fontSize: 10.5, fontWeight: 600, letterSpacing: 0.4 }}>
        {OP_LABEL[item.op]}
      </span>
      {item.ext && (
        <span
          style={{
            flexShrink: 0,
            fontFamily: "var(--font-mono)",
            fontSize: 8.5,
            fontWeight: 700,
            letterSpacing: 0.5,
            color: EXT_COLOR[item.ext] ?? "#8fa3b8",
            border: `1px solid ${(EXT_COLOR[item.ext] ?? "#8fa3b8")}55`,
            borderRadius: 4,
            padding: "1px 4px",
            lineHeight: 1.4,
          }}
        >
          {item.ext}
        </span>
      )}
      {item.fileName && (
        <span style={{ color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>
          {item.fileName}
        </span>
      )}
      {item.fileName && item.path && (
        <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 1 }}>
          {item.path}
        </span>
      )}
      {item.label && !item.fileName && (
        <code style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--text-secondary, var(--text))", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
          {item.label}
        </code>
      )}
      <span style={{ marginLeft: "auto", flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 7, fontSize: 10.5, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
        {item.detail && <span>{item.detail}</span>}
        {item.status === "running" && <span style={{ color: "var(--accent)" }}>●</span>}
        {item.status === "done" && <span style={{ color: "var(--success)" }}>✓</span>}
        {item.status === "failed" && <span style={{ color: "var(--danger, #F25F75)" }}>✕</span>}
      </span>
      {item.error && (
        <span style={{ display: "none" }} />
      )}
    </div>
  );
}

/** "Read 12 files — Expand" for rapid read bursts; edits never collapse. */
export function ToolActivityGroup({ group }: { group: GroupItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ margin: "2px 0" }}>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          height: 30,
          padding: "0 10px",
          borderRadius: 6,
          background: "rgba(255,255,255,0.02)",
          border: "1px solid var(--border-soft, rgba(255,255,255,0.06))",
          cursor: "pointer",
          fontSize: 12,
          minWidth: 0,
        }}
      >
        <span style={{ color: "var(--text-muted)", display: "inline-flex" }}>
          <IconFile size={13} />
        </span>
        <span style={{ fontSize: 12, color: "var(--text)" }}>
          Read <b>{group.items.length}</b> files
        </span>
        <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--text-muted)" }}>
          {open ? "Hide ▴" : "Expand ▾"}
        </span>
      </div>
      {open && (
        <div style={{ margin: "4px 0 4px 14px", borderLeft: "1px solid var(--border-soft, rgba(255,255,255,0.06))", paddingLeft: 8 }}>
          {group.items.map((t) => (
            <ToolActivityRow key={t.key} item={t} />
          ))}
        </div>
      )}
    </div>
  );
}
