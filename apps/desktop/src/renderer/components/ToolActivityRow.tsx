import React, { useEffect, useRef, useState } from "react";
import type { GroupItem, ToolItem, ToolOp, WorkGroupItem } from "../presentationReducer";
import { openArtifactInContext } from "../contextOpen";
import { FileTypeIcon as BrandFileTypeIcon } from "./FileTypeIcon";
import { IconFile, IconSearch, IconTerminal, IconGlobe, IconWrench } from "./Icons";
import "./ConversationActivity.css";

const LABELS: Record<ToolOp, [string, string]> = {
  read: ["Reading", "Read"], create: ["Writing", "Wrote"], edit: ["Editing", "Edited"],
  delete: ["Deleting", "Deleted"], search: ["Searching", "Searched"], terminal: ["Running", "Ran"],
  browser: ["Using browser", "Used browser"], git: ["Checking Git", "Checked Git"],
  test: ["Running tests", "Ran tests"], web: ["Researching", "Researched"], other: ["Using tool", "Used tool"],
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
    ? (item.status === "stopped" ? "stopped" : item.detail && item.detail !== "Command failed" ? item.detail : "failed")
    : running
      ? (generating ? "working…" : "")
      : item.detail ?? "";
  // A command that ran and reported failing tests is a finding, not a crash:
  // amber like the site's "2 failing", with the result as the meta.
  const warn = failed && item.op === "terminal" && /failing|exit \d/.test(meta);
  const open = item.ctx
    ? () => openArtifactInContext({ tab: item.ctx!, path: item.fileName ? `${item.path ?? ""}${item.fileName}` : undefined, fileName: item.fileName, op: item.op, url: item.url })
    : undefined;
  return <div className={`tool-line tool-line--${item.status}${warn ? " tool-line--warn" : ""}`}>
    <div
      className={`tool-line__row${open ? " is-link" : ""}`}
      onClick={open}
      role={open ? "button" : undefined}
      tabIndex={open ? 0 : undefined}
      onKeyDown={open ? (e) => { if (e.key === "Enter") open(); } : undefined}
      title={item.fileName ? `${item.path ?? ""}${item.fileName}` : target}
    >
      <span className="tool-line__state"><StateIcon status={item.status} warn={warn} /></span>
      <span className="tool-line__icon">{item.fileName ? <FileTypeIcon name={item.fileName} ext={item.ext} /> : <ActivityIcon op={item.op} />}</span>
      <span className="tool-line__verb">{verb}</span>
      {item.verifier && <span className="tool-line__by" title="Independent read-only check, not ORION's own work">verifier</span>}
      {target && <code className="tool-line__target">{target}</code>}
      {meta && <em className="tool-line__meta">{meta}</em>}
      {open && <span className="tool-line__open" aria-label="Open">↗</span>}
    </div>
    {item.toolName === "generate_image" && running && <ImageSketch name={item.fileName} />}
    {item.output && running && (
      <pre className="tool-line__live" aria-live="polite">{liveTail(item.output)}</pre>
    )}
    {item.error && failed && !warn && <div className="tool-line__error">{item.error}</div>}
    {item.output && !running && <>
      <button className="tool-line__toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Hide output" : "Output"}</button>
      {expanded && <><pre className="tool-line__live tool-line__live--full">{item.output}</pre>{item.outputTruncated && <div className="tool-line__note">Showing the last portion of the output.</div>}</>}
    </>}
  </div>;
}
export function ToolActivityGroup({ group }: { group: GroupItem }) {
  return <details className="activity-group"><summary>{group.items.length} file operations</summary>{group.items.map(item => <ToolActivityRow key={item.key} item={item} />)}</details>;
}
export function WorkGroupRow({ group }: { group: WorkGroupItem }) {
  if (group.type === "inspection") {
    const status = group.status === "running" ? "running" : group.status === "done" ? "done" : "failed";
    const single = group.items.length === 1 ? group.items[0] : null;
    if (single) return <div className="activity-phase"><ToolActivityRow item={single} /></div>;
    return (
      <details className="activity-phase tool-line-group">
        <summary className={`tool-line tool-line--${status}`}>
          <span className="tool-line__row">
            <span className="tool-line__state"><StateIcon status={status} /></span>
            <span className="tool-line__icon"><IconSearch size={14} /></span>
            <span className="tool-line__verb">{group.status === "running" ? "Exploring" : "Explored"}</span>
            {group.summary && <code className="tool-line__target">{group.summary}</code>}
            <em className="tool-line__meta">details ▾</em>
          </span>
        </summary>
        <div className="tool-line-group__items">{group.items.map((item) => <ToolActivityRow key={item.key} item={item} />)}</div>
      </details>
    );
  }
  if (group.items.length === 1) {
    return <div className="activity-phase">{group.items.map((item) => <ToolActivityRow key={item.key} item={item} />)}</div>;
  }
  return (
    <div className="activity-phase">
      {group.items.map((item) => <ToolActivityRow key={item.key} item={item} />)}
    </div>
  );
}
