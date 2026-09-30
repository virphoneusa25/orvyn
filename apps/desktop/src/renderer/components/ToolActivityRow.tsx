import React, { useEffect, useRef, useState } from "react";
import type { GroupItem, ToolItem, ToolOp, WorkGroupItem } from "../presentationReducer";
import { openArtifactInContext } from "../contextOpen";
import { FileTypeIcon as BrandFileTypeIcon } from "./FileTypeIcon";
import { IconFile, IconSearch, IconTerminal, IconGlobe, IconWrench } from "./Icons";
import "./ConversationActivity.css";

// Quiet, one-line steps like a coding assistant's log: "Terminal  npm test",
// "Read  index.html", "Edited  styles.css".
const LABELS: Record<ToolOp, [string, string]> = {
  read: ["Reading", "Read"], create: ["Writing", "Wrote"], edit: ["Editing", "Edited"],
  delete: ["Deleting", "Deleted"], search: ["Searching", "Search"], terminal: ["Running", "Terminal"],
  browser: ["Browsing", "Browser"], git: ["Checking Git", "Git"],
  test: ["Running tests", "Tests"], web: ["Researching", "Web"], other: ["Working", "Tool"],
};

/** "Terminal · 2 commands", "Read · 3 files" — consecutive steps of one kind. */
const GROUP_NOUN: Record<ToolOp, [string, string]> = {
  read: ["file", "files"], create: ["file", "files"], edit: ["file", "files"], delete: ["file", "files"],
  search: ["search", "searches"], terminal: ["command", "commands"], browser: ["action", "actions"],
  git: ["check", "checks"], test: ["run", "runs"], web: ["source", "sources"], other: ["step", "steps"],
};

/** One icon authority: the brand glyph set (official-style language marks,
 *  local SVGs) with a generic fallback. */
export function FileTypeIcon({ name }: { name: string; ext?: string }) {
  return <BrandFileTypeIcon path={name} />;
}
function ActivityIcon({ op }: { op: ToolOp }) {
  return op === "terminal" || op === "test" ? <IconTerminal size={16} /> : op === "search" ? <IconSearch size={16} /> : op === "browser" || op === "web" ? <IconGlobe size={16} /> : op === "edit" || op === "create" ? <IconWrench size={16} /> : <IconFile size={16} />;
}
function ImageSketch({ name }: { name?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let raf = 0;
    const paint = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.fillStyle = "#101218";
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 6; i++) {
        const x = w * (0.15 + 0.7 * (0.5 + 0.5 * Math.sin(frame / 48 + i)));
        const y = h * (0.18 + 0.64 * (0.5 + 0.5 * Math.cos(frame / 62 + i * 1.2)));
        const g = ctx.createRadialGradient(x, y, 0, x, y, 110);
        g.addColorStop(0, `rgba(${140 + i * 12}, ${150 + i * 8}, 190, 0.22)`);
        g.addColorStop(1, "rgba(16,18,24,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, 110, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = "rgba(230,234,242,0.22)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let x = 12; x < w - 12; x += 6) {
        const y = h * 0.55 + Math.sin(x / 22 + frame / 18) * 22 + Math.sin(x / 8 + iPhase(frame)) * 6;
        if (x === 12) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (!reduce) raf = requestAnimationFrame(paint);
      frame += 1;
    };
    paint();
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="image-sketch" role="status" aria-live="polite" aria-label={name ? `Drawing ${name}` : "Drawing image"}>
      <canvas ref={ref} width={640} height={400} />
      <div className="image-sketch-caption">Drawing{name ? ` ${name}` : " the image"}</div>
    </div>
  );
}

function iPhase(frame: number): number {
  return frame / 30;
}

/** The last lines of a running command's output. */
export function liveTail(output: string, lines = 12): string {
  const all = output.replace(/\r\n?/g, "\n").split("\n");
  if (all.length && all[all.length - 1] === "") all.pop();
  return all.slice(-lines).join("\n");
}

const StateIcon = ({ status, warn }: { status: ToolItem["status"]; warn?: boolean }) =>
  status === "running" ? <i className="tool-line__spin" aria-hidden="true" />
  : warn
    ? <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v6M8 12.5v.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>
  : status === "failed" || status === "stopped"
    ? <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
    : <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;

/**
 * One tool step as a single line, the way the ORVYN site shows the app:
 * [spinner → ✓ / ✕] [icon] Verb `target` ……… result
 * Running commands print their newest output underneath while they run.
 */
export function ToolActivityRow({ item }: { item: ToolItem }) {
  const [expanded, setExpanded] = useState(false);
  const command = item.op === "terminal";
  const running = item.status === "running";
  const failed = item.status === "failed" || item.status === "stopped";
  const generating = item.toolName === "generate_image" || item.toolName === "create_document" || item.toolName === "create_zip" || item.toolName === "artifact_create";
  const verb = item.toolName === "generate_image"
    ? (item.status === "done" && item.fileName ? "Generated" : "Generating image")
    : LABELS[item.op][running ? 0 : 1];
  const target = item.fileName ?? (command ? (item.label || "Preparing command…") : item.label);
  const meta = failed
    ? (item.status === "stopped" ? "stopped" : item.detail && item.detail !== "Command failed" ? item.detail : "")
    : running
      ? (generating ? "working…" : "")
      : /^(done|completed?|ok|success|exit 0|command completed)$/i.test(String(item.detail ?? "").trim()) ? "" : item.detail ?? "";
  // A command that ran and reported failing tests is a finding, not a crash:
  // amber like the site's "2 failing", with the result as the meta.
  const warn = failed && item.op === "terminal" && /failing|exit \d/.test(meta);
  const open = item.ctx
    ? () => openArtifactInContext({ tab: item.ctx!, path: item.fileName ? `${item.path ?? ""}${item.fileName}` : undefined, fileName: item.fileName, op: item.op, url: item.url })
    : undefined;
  // Clicking the row shows its output or error (quiet by default); ↗ opens the file or page.
  const expandable = Boolean((item.output && !running) || (item.error && failed && !warn));
  const toggle = expandable ? () => setExpanded((on) => !on) : open;
  return <div className={`tool-line tool-line--${item.status}${warn ? " tool-line--warn" : ""}${expanded ? " is-expanded" : ""}`}>
    <div
      className={`tool-line__row${toggle ? " is-link" : ""}`}
      onClick={toggle}
      role={toggle ? "button" : undefined}
      aria-expanded={expandable ? expanded : undefined}
      tabIndex={toggle ? 0 : undefined}
      onKeyDown={toggle ? (e) => { if (e.key === "Enter") toggle(); } : undefined}
      title={failed && item.error ? item.error : item.fileName ? `${item.path ?? ""}${item.fileName}` : target}
    >
      <span className="tool-line__icon">{running ? <i className="tool-line__spin" aria-hidden="true" /> : item.fileName ? <FileTypeIcon name={item.fileName} ext={item.ext} /> : <ActivityIcon op={item.op} />}</span>
      <span className="tool-line__verb">{verb}</span>
      {item.verifier && <span className="tool-line__by" title="Independent read-only check, not ORION's own work">verifier</span>}
      {target && <code className="tool-line__target">{target}</code>}
      {meta && <em className="tool-line__meta">{meta}</em>}
      {item.condensed && <span className="tool-line__by" data-testid="tool-condensed" title={`The output was ${item.condensed.fromChars.toLocaleString()} characters; ORION read a ${item.condensed.toChars.toLocaleString()}-character digest${item.condensed.digested ? " made by a cheaper model" : ""} (errors and warnings kept verbatim). You see the full output here.`}>digest for ORION</span>}
      {(failed || warn) && <span className="tool-line__state" title={item.error || meta}><StateIcon status={item.status} warn={warn} /></span>}
      {open && <span className="tool-line__open" role="button" aria-label="Open" onClick={(e) => { e.stopPropagation(); open(); }}>↗</span>}
    </div>
    {item.toolName === "generate_image" && running && <ImageSketch name={item.fileName} />}
    {item.output && running && (
      <pre className="tool-line__live" aria-live="polite">{liveTail(item.output)}</pre>
    )}
    {expanded && item.error && failed && !warn && <div className="tool-line__error">{item.error}</div>}
    {expanded && item.output && !running && <><pre className="tool-line__live tool-line__live--full">{item.output}</pre>{item.outputTruncated && <div className="tool-line__note">Showing the last portion of the output.</div>}</>}
  </div>;
}
/**
 * Consecutive steps of one kind as one quiet row: "Terminal · 2 commands".
 * While one runs, the row reads "Running <its target>". Click to see each step.
 */
export function ToolRunGroup({ items }: { items: ToolItem[] }) {
  const op = items[0]!.op;
  const running = items.find((i) => i.status === "running");
  const failedCount = items.filter((i) => i.status === "failed" || i.status === "stopped").length;
  const [noun, nouns] = GROUP_NOUN[op];
  const done = LABELS[op][1];
  const target = running ? (running.fileName ?? running.label ?? "") : "";
  return (
    <details className={`activity-phase tool-line-group tool-run-group${running ? " is-running" : ""}`} data-testid="tool-run-group">
      <summary className={`tool-line tool-line--${running ? "running" : failedCount ? "failed" : "done"}`}>
        <span className="tool-line__row is-link">
          <span className="tool-line__icon">{running ? <i className="tool-line__spin" aria-hidden="true" /> : <ActivityIcon op={op} />}</span>
          <span className="tool-line__verb">{running ? LABELS[op][0] : done}</span>
          {running
            ? target && <code className="tool-line__target">{target}</code>
            : <span className="tool-line__count">· {items.length} {items.length === 1 ? noun : nouns}</span>}
          {failedCount > 0 && !running && <em className="tool-line__meta tool-line__meta--failed">{failedCount} failed</em>}
        </span>
      </summary>
      <div className="tool-line-group__items">{items.map((item) => <ToolActivityRow key={item.key} item={item} />)}</div>
    </details>
  );
}

export function ToolActivityGroup({ group }: { group: GroupItem }) {
  return <details className="activity-group"><summary>{group.items.length} file operations</summary>{group.items.map(item => <ToolActivityRow key={item.key} item={item} />)}</details>;
}
export function WorkGroupRow({ group }: { group: WorkGroupItem }) {
  if (group.type === "inspection") {
    // superseded: an exploration that failed while overall verification
    // passed — optional, not a defect of the result.
    const status = group.status === "running" ? "running" : group.status === "done" || group.status === "superseded" ? "done" : "failed";
    const single = group.items.length === 1 ? group.items[0] : null;
    if (single) return <div className="activity-phase"><ToolActivityRow item={single} /></div>;
    return (
      <details className="activity-phase tool-line-group">
        <summary className={`tool-line tool-line--${status}`}>
          <span className="tool-line__row">
            <span className="tool-line__icon">{status === "running" ? <i className="tool-line__spin" aria-hidden="true" /> : <IconSearch size={14} />}</span>
            <span className="tool-line__verb">{group.status === "running" ? "Exploring" : "Explore"}</span>
            {group.summary && <span className="tool-line__count">· {group.summary}</span>}
            {status === "failed" && <span className="tool-line__state"><StateIcon status="failed" /></span>}
          </span>
        </summary>
        <div className="tool-line-group__items">{group.items.map((item) => <ToolActivityRow key={item.key} item={item} />)}</div>
      </details>
    );
  }
  if (group.items.length === 1) {
    return <div className="activity-phase">{group.items.map((item) => <ToolActivityRow key={item.key} item={item} />)}</div>;
  }
  if (group.type === "edits") {
    return (
      <div className="activity-phase site-progress" data-testid="site-progress">
        <div className="site-progress__title">{group.title}</div>
        {group.items.map((item) => (
          <div key={item.key} className="site-progress__line">
            <span className="site-progress__mark" aria-hidden="true">{item.status === "running" ? "↻" : item.status === "failed" || item.status === "stopped" ? "!" : "✓"}</span>
            <span>{editProgressLine(item)}</span>
          </div>
        ))}
        {(group.notes ?? []).map((note) => (
          <div key={note} className="site-progress__line">
            <span className="site-progress__mark" aria-hidden="true">↻</span>
            <span>{note}</span>
          </div>
        ))}
      </div>
    );
  }
  // §11: groups with more than 5 actions collapse into a "▸ N actions"
  // line — the conversation stays readable, details are one click away.
  if (group.items.length > 5) {
    const verb = group.type === "browser" ? "Browser actions" : group.type === "checks" ? "Checks" : "Actions";
    const status = group.status === "running" ? "running" : group.status === "done" ? "done" : group.status === "failed" ? "failed" : "done";
    return (
      <details className="activity-phase tool-line-group" data-testid="workgroup-collapsed">
        <summary className={`tool-line tool-line--${status}`}>
          <span className="tool-line__row">
            <span className="tool-line__verb">{group.status === "running" ? verb : `${group.items.length} actions`}</span>
            <span className="tool-line__count">· {group.items.length} {group.items.length === 1 ? "action" : "actions"}</span>
          </span>
        </summary>
        <div className="tool-line-group__items">{group.items.map((item) => <ToolActivityRow key={item.key} item={item} />)}</div>
      </details>
    );
  }
  return (
    <div className="activity-phase">
      {group.items.map((item) => <ToolActivityRow key={item.key} item={item} />)}
    </div>
  );
}

function editProgressLine(item: ToolItem): string {
  const name = item.fileName || item.label || "file";
  if (item.status === "running") return `Updating ${name}`;
  if (/assets/i.test(name) && !/\.[a-z0-9]+$/i.test(name)) return "Created assets directory";
  if (/hero/i.test(item.label ?? "") || /hero/i.test(item.detail ?? "")) return "Added hero section";
  if (/nav/i.test(name)) return "Added navigation";
  return `${item.op === "delete" ? "Removed" : "Created"} ${name}`;
}
