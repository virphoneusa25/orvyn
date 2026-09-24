import React, { useEffect, useRef, useState } from "react";
import type { GroupItem, ToolItem, ToolOp, WorkGroupItem } from "../presentationReducer";
import { openArtifactInContext } from "../contextOpen";
import { FileTypeIcon as BrandFileTypeIcon } from "./FileTypeIcon";
import { IconFile, IconSearch, IconTerminal, IconGlobe, IconWrench } from "./Icons";
import "./ConversationActivity.css";

const LABELS: Record<ToolOp, [string, string]> = {
  read: ["Reading", "Read"], create: ["Writing", "Wrote"], edit: ["Editing", "Edited"],
  delete: ["Deleting", "Deleted"], search: ["Searching", "Searched"], terminal: ["Running command", "Ran command"],
  browser: ["Using browser", "Used browser"], git: ["Checking Git", "Checked Git"],
  test: ["Running tests", "Ran tests"], other: ["Using tool", "Used tool"],
};

/** One icon authority: the brand glyph set (official-style language marks,
 *  local SVGs) with a generic fallback. */
export function FileTypeIcon({ name }: { name: string; ext?: string }) {
  return <BrandFileTypeIcon path={name} />;
}
function ActivityIcon({ op }: { op: ToolOp }) {
  return op === "terminal" || op === "test" ? <IconTerminal size={16} /> : op === "search" ? <IconSearch size={16} /> : op === "browser" ? <IconGlobe size={16} /> : op === "edit" || op === "create" ? <IconWrench size={16} /> : <IconFile size={16} />;
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

export function ToolActivityRow({ item }: { item: ToolItem }) {
  const [expanded, setExpanded] = useState(false);
  const command = item.op === "terminal";
  const generating = item.toolName === "generate_image" || item.toolName === "create_document" || item.toolName === "create_zip" || item.toolName === "artifact_create";
  const state = item.status === "failed"
    ? "Failed"
    : item.status === "stopped"
      ? "Stopped"
      : item.status === "running"
        ? (item.toolName === "generate_image" ? "Drawing" : "In progress")
        : generating && item.fileName
          ? item.fileName
          : "Done";
  const verb = item.toolName === "generate_image"
    ? (item.status === "done" && item.fileName ? "Generated" : "Generate image")
    : item.status === "failed" || item.status === "stopped" ? LABELS[item.op][0] : LABELS[item.op][item.status === "running" ? 0 : 1];
  return <div className={`activity-item activity-${item.status}`}>
    <div className="activity-row" onClick={() => { if (item.op === "browser" && item.ctx) openArtifactInContext({ tab: item.ctx, path: item.fileName ? `${item.path ?? ""}${item.fileName}` : undefined, fileName: item.fileName, op: item.op }); }}>
      {item.fileName ? <FileTypeIcon name={item.fileName} ext={item.ext} /> : <ActivityIcon op={item.op} />}
      <div className="activity-target">
        <span className="activity-verb">{verb}</span>
        {item.fileName ? <><strong>{item.fileName}</strong><span className="activity-path">{item.path}</span></> : !command && <span>{item.label}</span>}
      </div>
      <span className="activity-state">{item.status === "running" && <span className="activity-pulse" />}{state}</span>
      {item.ctx && <button className="activity-link" aria-label={`Open ${item.fileName ?? item.label ?? verb} in ${item.ctx}`} onClick={() => openArtifactInContext({ tab: item.ctx!, path: item.fileName ? `${item.path ?? ""}${item.fileName}` : undefined, fileName: item.fileName, op: item.op })}>Open ↗</button>}
    </div>
    {item.toolName === "generate_image" && item.status === "running" && <ImageSketch name={item.fileName} />}
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
  if (group.type === "inspection") {
    return (
      <details className="activity-group stream-explore" open={group.status === "running" ? true : undefined}>
        <summary>
          <IconSearch size={14} />
          <span className="stream-explore-title">{group.title}{group.summary ? ` · ${group.summary}` : ""}</span>
          <span className="activity-state">{group.status === "running" ? "Running" : group.status === "done" ? "Done" : "Needs attention"}</span>
        </summary>
        {group.items.map((item) => <ToolActivityRow key={item.key} item={item} />)}
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
