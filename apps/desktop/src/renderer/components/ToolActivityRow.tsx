import React, { useState } from "react";
import type { GroupItem, ToolItem, ToolOp, WorkGroupItem } from "../presentationReducer";
import { IconFile, IconSearch, IconTerminal, IconGlobe, IconWrench } from "./Icons";
import "./ConversationActivity.css";

const LABELS: Record<ToolOp, [string, string]> = {
  read: ["Reading", "Read"], create: ["Writing", "Wrote"], edit: ["Editing", "Edited"],
  delete: ["Deleting", "Deleted"], search: ["Searching", "Searched"], terminal: ["Running command", "Ran command"],
  browser: ["Using browser", "Used browser"], git: ["Checking Git", "Checked Git"],
  test: ["Running tests", "Ran tests"], other: ["Using tool", "Used tool"],
};
const FILE_TYPES: Record<string, [string, string, string]> = {
  DOCX: ["Word document", "W", "#70a9ff"], PDF: ["PDF document", "PDF", "#f98b88"], XLSX: ["Excel spreadsheet", "X", "#78d4a3"], PPTX: ["PowerPoint presentation", "P", "#f3ad82"],
  PY: ["Python", "Py", "#72b7e8"], JS: ["JavaScript", "JS", "#f1d65c"], JSX: ["React JavaScript", "JSX", "#61dafb"],
  TS: ["TypeScript", "TS", "#66b4ff"], TSX: ["React TypeScript", "TSX", "#61dafb"],
  JSON: ["JSON", "{}", "#e6c76c"], CSS: ["CSS", "#", "#b29aff"], SCSS: ["Sass", "S", "#e29abe"],
  HTML: ["HTML", "<>", "#f49b76"], MD: ["Markdown", "M↓", "#aab9d0"],
  GO: ["Go", "Go", "#61d4e5"], RS: ["Rust", "Rs", "#e9ad8d"], JAVA: ["Java", "J", "#efad79"],
  CS: ["C sharp", "C#", "#b29aff"], CPP: ["C++", "C++", "#66b4ff"], C: ["C", "C", "#66b4ff"],
  YAML: ["YAML", "Y", "#df97b2"], YML: ["YAML", "Y", "#df97b2"], SQL: ["SQL", "DB", "#e6c76c"],
  SH: ["Shell", "$", "#8bd5a6"], PS1: ["PowerShell", ">_", "#66b4ff"],
};
export function FileTypeIcon({ name, ext }: { name: string; ext?: string }) {
  const type = FILE_TYPES[ext ?? ""] ?? (name.startsWith(".env") ? ["Environment", "•", "#e6c76c"] : [ext ? `${ext} file` : "File", ext?.slice(0, 3) ?? "•", "#aab9d0"]);
  return <svg className="activity-file-icon" viewBox="0 0 28 32" role="img" aria-label={type[0]}>
    <title>{type[0]}</title><path d="M4 1h13l7 7v22H4z" fill={type[2]} fillOpacity=".12" stroke={type[2]} />
    <path d="M17 1v8h7" fill="none" stroke={type[2]} />
    <text x="14" y="23" textAnchor="middle" fill={type[2]} fontSize="9" fontWeight="700">{type[1]}</text>
  </svg>;
}
function ActivityIcon({ op }: { op: ToolOp }) {
  return op === "terminal" || op === "test" ? <IconTerminal size={16} /> : op === "search" ? <IconSearch size={16} /> : op === "browser" ? <IconGlobe size={16} /> : op === "edit" || op === "create" ? <IconWrench size={16} /> : <IconFile size={16} />;
}
export function ToolActivityRow({ item }: { item: ToolItem }) {
  const [expanded, setExpanded] = useState(false);
  const command = item.op === "terminal";
  const state = item.status === "running" ? "In progress" : item.status === "done" ? "Done" : item.status === "stopped" ? "Stopped" : "Failed";
  const verb = item.status === "failed" || item.status === "stopped" ? LABELS[item.op][0] : LABELS[item.op][item.status === "running" ? 0 : 1];
  return <div className={`activity-item activity-${item.status}`}>
    <div className="activity-row">
      {item.fileName ? <FileTypeIcon name={item.fileName} ext={item.ext} /> : <ActivityIcon op={item.op} />}
      <div className="activity-target">
        <span className="activity-verb">{verb}</span>
        {item.fileName ? <><strong>{item.fileName}</strong><span className="activity-path">{item.path}</span></> : !command && <span>{item.label}</span>}
      </div>
      <span className="activity-state">{item.status === "running" && <span className="activity-pulse" />}{state}</span>
      {item.ctx && <button className="activity-link" aria-label={`Open ${item.fileName ?? item.label ?? verb} in ${item.ctx}`} onClick={() => document.dispatchEvent(new CustomEvent("orvyn:context-tab", { detail: { tab: item.ctx, pin: true } }))}>Open ↗</button>}
    </div>
    {command && <pre className="activity-command"><span aria-hidden="true">$ </span>{item.label || "Preparing command…"}</pre>}
    {item.detail && <div className="activity-detail">{item.detail}</div>}
    {item.error && <div className="activity-error">{item.error}</div>}
    {item.output && <>
      <button className="activity-link activity-output-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Hide output ▴" : "Show output ▾"}</button>
      {expanded && <><pre className="activity-output">{item.output}</pre>{item.outputTruncated && <div className="activity-detail">Showing the last portion of the output.</div>}</>}
    </>}
  </div>;
}
export function ToolActivityGroup({ group }: { group: GroupItem }) {
  return <details className="activity-group"><summary>{group.items.length} file operations</summary>{group.items.map(item => <ToolActivityRow key={item.key} item={item} />)}</details>;
}
export function WorkGroupRow({ group }: { group: WorkGroupItem }) {
  // File changes and commands are always visible. Only repetitive inspections collapse.
  if (group.type !== "inspection" || group.items.length <= 3) {
    return <div className="activity-phase">{group.items.map(item => <ToolActivityRow key={item.key} item={item} />)}</div>;
  }
  return <details className="activity-group" open={group.status === "running" ? true : undefined}>
    <summary><IconSearch size={14} /><span>{group.title}</span><span className="activity-detail">{group.summary}</span><span className="activity-state">{group.status === "running" ? "In progress" : group.status === "done" ? "Done" : "Needs attention"}</span></summary>
    {group.items.map(item => <ToolActivityRow key={item.key} item={item} />)}
  </details>;
}
