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
    // No Astra plan. For a live run that's normal pre-planning; for a
    // terminal run it means the request never became a mission — saying
    // "Working" then would contradict the status badge.
    if (status === "completed" || status === "error" || status === "cancelled") {
      return (
        <Card title="MISSION PLAN" badge={statusBadge(status)}>
          <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)", padding: "2px 0" }}>
            No mission steps — this request did not become a mission.
          </div>
        </Card>
      );
    }
    const steps = events.filter((e) => e.type === "thinking").length;
    if (steps === 0) return null;
    return (
      <Card title="MISSION PLAN" badge={statusBadge(status)}>
        <div style={{ fontSize: 12, color: "var(--orvyn-text-secondary)", padding: "2px 0" }}>
          <StepMarker state="active" /> Astra is analyzing your request…
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
      return `${toolLabel(String(d.tool))}…`;
    case "tool.completed":
      return `${toolLabel(String(d.tool))} done`;
    case "tool.failed":
      return `${toolLabel(String(d.tool))} failed — ${String(d.error ?? "").slice(0, 80)}`;
    case "file.read":
      return `Reading ${String(d.path)}`;
    case "file.edit":
      return `Editing ${String(d.path)}`;
    case "terminal.started":
      return `Running ${String(d.command ?? "").slice(0, 90)}`;
    case "sandbox.started":
      return "Isolated sandbox started";
    case "sandbox.stopped":
      return `Sandbox finished — ${Number(d.mergedFiles ?? 0)} file(s) merged back`;
    case "checkpoint.created":
      return "Checkpoint saved (Undo available)";
    case "checkpoint.restored":
      return "Restored to checkpoint";
    case "review.started":
      return "Astra is reviewing the result…";
    case "review.passed":
      return "Review passed";
    case "review.rejected":
      return `Review requested changes — ${String(d.notes ?? "").slice(0, 80)}`;
    case "context.compacted":
      return "Context optimized to stay within the model window";
    case "task.started":
      return `Step started: ${String(d.description ?? "").slice(0, 80)}`;
    case "mission.created":
      return "Mission created";
    case "mission.started":
      return "Mission underway";
    default:
      return friendlyEventType(e.type);
  }
}

/** Internal tool names → customer-facing verbs. */
function toolLabel(tool: string): string {
  const labels: Record<string, string> = {
    read_file: "Reading a file",
    write_file: "Writing a file",
    edit_file: "Editing a file",
    delete_file: "Deleting a file",
    move_file: "Moving a file",
    list_directory: "Listing files",
    search_files: "Searching files",
    search_code: "Searching code",
    list_symbols: "Inspecting symbols",
    terminal: "Running a command",
    run_command: "Running a command",
    run_tests: "Running tests",
    run_typecheck: "Running type checks",
    run_linter: "Running lint",
    git_status: "Checking Git status",
    git_diff: "Reading changes",
    git_commit: "Committing",
    ssh_exec: "Running a command over SSH",
    fetch_url: "Fetching a page",
    web_search: "Searching the web",
    browser_open: "Opening the browser",
    browser_navigate: "Navigating",
    browser_click: "Clicking",
    browser_screenshot: "Capturing a screenshot",
    get_diagnostics: "Checking diagnostics",
  };
  return labels[tool] ?? tool.replace(/_/g, " ");
}

function friendlyEventType(type: string): string {
  const map: Record<string, string> = {
    "run.started": "Request accepted",
    "run.completed": "Completed",
    "run.cancelled": "Stopped",
    "plan.created": "Plan ready",
    "mission.completed": "Mission completed",
    "mission.blocked": "Mission blocked — needs your decision",
    "approval.required": "Waiting for your approval",
    "approval.resolved": "Approval resolved",
    "test.started": "Testing changes",
    "test.completed": "Tests finished",
  };
  return map[type] ?? type.replace(/[._]/g, " ");
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
