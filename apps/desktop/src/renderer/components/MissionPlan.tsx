// apps/desktop/src/renderer/components/MissionPlan.tsx
//
// The mockup's Mission Plan card, driven entirely by real Task Engine
// events: plan.created defines the numbered steps; task.started/completed/
// failed move them. Where there is no plan (single-agent runs), the card
// shows the honest live step count instead of inventing a plan.
import React from "react";
import { AgentEvent } from "./AgentActivityList";

interface PlanTask {
  id: string;
  description: string;
}

export function MissionPlan({ events, status }: { events: AgentEvent[]; status: string }) {
  const plan = events.find((e) => e.type === "plan.created");
  const tasks = (plan?.data.tasks ?? []) as PlanTask[];

  if (tasks.length === 0) {
    const steps = events.filter((e) => e.type === "thinking").length;
    if (steps === 0) return null;
    return (
      <Card title="MISSION PLAN" badge={statusBadge(status)}>
        <div style={{ fontSize: 12, color: "var(--orvyn-text-secondary)", padding: "2px 0" }}>
          <StepMarker state="active" /> Working — step {steps}
        </div>
      </Card>
    );
  }

  const stateById = new Map<string, string>();
  for (const e of events) {
    if (e.type === "task.started") stateById.set(String(e.data.taskId ?? e.data.description), "active");
    if (e.type === "task.completed") stateById.set(String(e.data.taskId ?? e.data.description), "done");
    if (e.type === "task.failed") stateById.set(String(e.data.taskId ?? e.data.description), "failed");
  }

  return (
    <Card title="MISSION PLAN" badge={statusBadge(status)}>
      {tasks.map((t, i) => {
        const state = stateById.get(t.id) ?? "pending";
        return (
          <div key={t.id} style={{ display: "flex", gap: 9, padding: "3px 0", alignItems: "baseline" }}>
            <StepMarker state={state as "done" | "active" | "pending" | "failed"} />
            <span style={{ fontSize: 12, color: "var(--orvyn-text-secondary)", minWidth: 14 }}>{i + 1}.</span>
            <span
              style={{
                fontSize: 12,
                color: state === "done" ? "var(--orvyn-text-muted)" : "var(--orvyn-text)",
                textDecoration: state === "done" ? "none" : undefined,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {t.description}
            </span>
          </div>
        );
      })}
    </Card>
  );
}

function StepMarker({ state }: { state: "done" | "active" | "pending" | "failed" }) {
  if (state === "done")
    return (
      <span style={{ color: "var(--orvyn-green)", fontSize: 12, width: 12, display: "inline-block" }}>✓</span>
    );
  if (state === "failed")
    return (
      <span style={{ color: "var(--orvyn-red)", fontSize: 12, width: 12, display: "inline-block" }}>✗</span>
    );
  if (state === "active")
    return (
      <span style={{ width: 12, display: "inline-block" }}>
        <span
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "var(--orvyn-purple)",
            boxShadow: "0 0 8px var(--orvyn-purple)",
          }}
        />
      </span>
    );
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        border: "1.5px solid var(--orvyn-border)",
        display: "inline-block",
        marginLeft: 2,
      }}
    />
  );
}

export function LiveActivity({ events }: { events: AgentEvent[] }) {
  const lines = events
    .filter((e) => ACTIVITY_TYPES.has(e.type))
    .slice(-12)
    .reverse();

  if (lines.length === 0) return null;

  return (
    <Card title="LIVE ACTIVITY">
      {lines.map((e) => (
        <div key={e.id} style={{ display: "flex", gap: 10, padding: "2.5px 0", fontSize: 11.5 }}>
          <span style={{ color: "var(--orvyn-text-muted)", fontFamily: "var(--font-mono)", fontSize: 10.5, flexShrink: 0 }}>
            {new Date(e.timestamp).toLocaleTimeString([], { hour12: false })}
          </span>
          <span style={{ color: "var(--orvyn-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {describe(e)}
          </span>
        </div>
      ))}
    </Card>
  );
}

const ACTIVITY_TYPES = new Set([
  "tool.started",
  "tool.completed",
  "tool.failed",
  "file.read",
  "file.edit",
  "terminal.started",
  "sandbox.started",
  "sandbox.stopped",
  "checkpoint.created",
  "checkpoint.restored",
  "review.started",
  "review.passed",
  "review.rejected",
  "context.compacted",
  "mission.created",
  "task.started",
]);

function describe(e: AgentEvent): string {
  const d = e.data as Record<string, unknown>;
  switch (e.type) {
    case "tool.started":
      return `${String(d.tool)}(${shortInput(d)})`;
    case "tool.completed":
      return `${String(d.tool)} done`;
    case "tool.failed":
      return `${String(d.tool)} failed — ${String(d.error ?? "").slice(0, 80)}`;
    case "file.read":
      return `Read ${String(d.path)}`;
    case "file.edit":
      return `Edited ${String(d.path)}`;
    case "terminal.started":
      return String(d.command ?? "").slice(0, 90);
    case "sandbox.started":
      return "Sandbox container started";
    case "sandbox.stopped":
      return `Sandbox stopped (${Number(d.mergedFiles ?? 0)} files merged back)`;
    case "checkpoint.created":
      return "Checkpoint created (Undo available)";
    case "checkpoint.restored":
      return "Checkpoint restored";
    case "review.started":
      return "Astra review started";
    case "review.passed":
      return "Review passed";
    case "review.rejected":
      return `Review rejected — ${String(d.notes ?? "").slice(0, 80)}`;
    case "context.compacted":
      return `Context compacted to ${Number(d.tokensAfter ?? 0).toLocaleString()} tokens`;
    case "task.started":
      return `▶ ${String(d.description ?? "").slice(0, 80)}`;
    default:
      return e.type;
  }
}

function shortInput(d: Record<string, unknown>): string {
  const first = Object.values(d.input ?? {})[0];
  return first ? String(first).slice(0, 40) : "";
}

function Card({ title, badge, children }: { title: string; badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: "var(--orvyn-surface-2)",
        border: "1px solid var(--orvyn-border-soft)",
        borderRadius: "var(--orvyn-radius-md)",
        padding: "10px 12px",
        marginBottom: 10,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.2, color: "var(--orvyn-text-muted)" }}>
          {title}
        </span>
        {badge && <span style={{ marginLeft: "auto" }}>{badge}</span>}
      </div>
      {children}
    </div>
  );
}

function statusBadge(status: string): React.ReactNode {
  const color =
    status === "completed" ? "var(--orvyn-green)"
    : status === "error" ? "var(--orvyn-red)"
    : status === "cancelled" ? "var(--orvyn-yellow)"
    : "var(--orvyn-purple-hi)";
  return (
    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.8, color, border: `1px solid ${color}55`, borderRadius: 4, padding: "1px 7px" }}>
      {status.toUpperCase()}
    </span>
  );
}
