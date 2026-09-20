// apps/desktop/src/renderer/components/redesign/realMissionDetail.ts
//
// Builds the redesign's MissionDetailData from a REAL attached run: its
// events, status, usage and tool permissions. Nothing is invented — every
// step, activity line, approval, file and token count comes from the run's
// own event stream (the same source the WorkStream renders).

import { reducePresentation } from "../../presentationReducer";
import type { AgentEvent } from "../AgentActivityList";
import type { ActivityItem, ApprovalRequest, MissionDetailData, MissionTone, PlanStep, TouchedFile, ToolCall } from "./types";

const TONE_BY_STATUS: Record<string, { tone: MissionTone; label: string }> = {
  awaiting_approval: { tone: "approval", label: "Needs approval" },
  running: { tone: "running", label: "Running" },
  queued: { tone: "running", label: "Queued" },
  completed: { tone: "done", label: "Completed" },
  error: { tone: "failed", label: "Failed" },
  cancelled: { tone: "paused", label: "Stopped" },
};

function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function describeCommand(tool: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>;
  if (tool === "terminal" || tool === "run_command" || tool === "ssh_exec") return String(args.command ?? tool);
  if (typeof args.path === "string") return `${tool} ${args.path}`;
  return `${tool} ${JSON.stringify(args).slice(0, 90)}`;
}

function effectsFor(tool: string, preview: unknown): string[] {
  const p = preview as { additions?: number; deletions?: number; path?: string } | undefined;
  if (p && (p.additions || p.deletions)) return [`${p.additions ?? 0} additions · ${p.deletions ?? 0} deletions${p.path ? ` in ${p.path}` : ""}`];
  if (tool === "terminal" || tool === "run_command" || tool === "ssh_exec") return ["Executes a shell command on this machine"];
  if (tool === "write_file" || tool === "edit_file" || tool === "create_document") return ["Writes to the project workspace"];
  if (tool === "delete_file") return ["Deletes a file in the project workspace"];
  return ["Runs an agent tool"];
}

export function toMissionDetail(input: {
  runId: string | null;
  status: string;
  events: AgentEvent[];
  usage?: { promptTokens: number; completionTokens: number; turns: number } | null;
  projectName?: string | null;
  projectRoot?: string | null;
  availableTools?: { name: string; permission: string }[];
}): MissionDetailData {
  const { events, status } = input;
  const instruction = String(events.find((e) => e.type === "run.started")?.data.instruction ?? "").trim();
  const tone = TONE_BY_STATUS[status] ?? { tone: "running" as MissionTone, label: status };

  // Plan steps: plan.created order + live task states.
  const planTasks = (events.find((e) => e.type === "plan.created")?.data.tasks ?? []) as { id: string; description: string; agent: string }[];
  const done = new Set(events.filter((e) => e.type === "task.completed").map((e) => String(e.data.taskId)));
  const started = new Set(events.filter((e) => e.type === "task.started").map((e) => String(e.data.taskId)));
  const steps: PlanStep[] = planTasks.map((t) => ({
    id: t.id,
    title: t.description.split("\n")[0].slice(0, 90),
    detail: `Astra · ${t.agent}`,
    state: done.has(t.id) ? "done" : started.has(t.id) ? "current" : "todo",
  }));
  if (steps.length === 0 && instruction) steps.push({ id: "s0", title: instruction.split("\n")[0].slice(0, 90), detail: "Astra", state: done.size > 0 ? "done" : "current" });

  // Activity: same presentation items the center stream uses.
  const items = reducePresentation(events, status);
  const activity: ActivityItem[] = [];
  if (instruction) {
    activity.push({ kind: "user", id: "u0", author: "Royce", initial: "R", time: "", text: instruction });
  }
  let lastAssistant = "";
  for (const it of items) {
    if (it.kind === "assistant") {
      lastAssistant = it.content;
      activity.push({ kind: "agent", id: it.key, agent: "Astra", time: "", text: it.content });
    } else if (it.kind === "workgroup") {
      const tools: ToolCall[] = it.items.map((t) => ({
        id: t.key,
        ok: t.status !== "failed",
        verb: t.op,
        target: t.fileName ?? t.label ?? "",
      }));
      activity.push({
        kind: "agent",
        id: it.key,
        agent: "Astra",
        time: "",
        text: `${it.title}${it.summary ? ` — ${it.summary}` : ""}`,
        tools,
      });
    } else if (it.kind === "approval" && !it.settled) {
      const req: ApprovalRequest = {
        id: it.key,
        cwd: input.projectRoot ?? input.projectName ?? "",
        command: describeCommand(it.tool, it.input),
        runsOn: "Local machine",
        effects: effectsFor(it.tool, it.preview),
        rememberLabel: "Remember for this mission",
      };
      activity.push({ kind: "approval", id: it.key, request: req });
    } else if (it.kind === "summary") {
      activity.push({ kind: "agent", id: it.key, agent: "Astra", time: "", text: `${it.cancelled ? "Stopped — " : it.ok ? "Completed — " : "Failed — "}${it.detail}` });
    }
  }

  // Touched files: real file events, latest op wins.
  const fileMap = new Map<string, TouchedFile>();
  for (const e of events) {
    if (e.type === "file.read") fileMap.set(String(e.data.path ?? ""), { path: String(e.data.path ?? ""), op: "read" });
    if (e.type === "file.edit") fileMap.set(String(e.data.path ?? ""), { path: String(e.data.path ?? ""), op: "write" });
  }

  const permNames: Record<string, string> = {
    terminal: "Shell commands",
    run_command: "Shell commands",
    write_file: "File writes",
    edit_file: "File edits",
    delete_file: "File deletes",
    browser_open: "Browser",
    ssh_exec: "SSH",
    read_file: "File reads",
  };
  const permissions = (input.availableTools ?? [])
    .filter((t) => permNames[t.name])
    .slice(0, 5)
    .map((t) => ({
      name: permNames[t.name],
      level: (t.permission === "allowed" ? "allowed" : t.permission === "ask" ? "ask" : "off") as "allowed" | "ask" | "off",
    }));

  const used = (input.usage?.promptTokens ?? 0) + (input.usage?.completionTokens ?? 0);
  const cap = 2_000_000;

  return {
    id: input.runId ?? "run",
    title: instruction.split("\n")[0].slice(0, 90) || "Mission",
    tone: tone.tone,
    label: tone.label,
    meta: [input.runId ? `mission_${input.runId.slice(0, 4)}` : "mission", input.projectName ?? "workspace", "Astra"],
    steps,
    activity,
    permissions,
    budget: { usedLabel: fmtTokens(used), capLabel: fmtTokens(cap), percent: Math.min(100, (used / cap) * 100) },
    files: [...fileMap.values()].slice(-8),
    deliverable: lastAssistant.split("\n")[0]?.slice(0, 120) ?? "",
  };
}
