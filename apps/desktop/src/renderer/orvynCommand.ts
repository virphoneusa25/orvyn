// apps/desktop/src/renderer/orvynCommand.ts
//
// THE canonical command pipeline. Every UI entry point (Home composer, quick
// actions, chat panel follow-ups) submits through submitOrvynCommand() so
// classification, routing and error handling live in exactly one place.
//
// Routing is intentionally simple and transparent: the mode chips are the
// user's explicit instruction. Only when the mode is ambiguous do we lean on
// a conservative conversational heuristic (short question → chat), because a
// wrong keyword guess that silently opens a mission is worse than a question
// landing in chat.

import { apiUrl, authHeaders } from "./connection";
import { startUserTurn, appendAssistantDelta, finishAssistantTurn } from "./chatSession";
import { wsUrl } from "./connection";
import { classifyIntent, CommandMode } from "./orvynIntent";
import type { Attachment } from "./components/AttachmentBar";

export type { CommandMode } from "./orvynIntent";
export type CommandSource = "HOME" | "CHAT" | "NEW_TASK" | "QUICK_ACTION" | "MISSION";

export interface OrvynCommand {
  prompt: string;
  mode: CommandMode;
  source: CommandSource;
  projectRoot: string | null;
  attachments?: Attachment[];
}

export type CommandOutcome =
  | { kind: "chat" }
  | { kind: "mission"; runId: string }
  | { kind: "run"; runId: string }
  | { kind: "error"; error: string };

/** Starts a chat turn into the shared session — returns IMMEDIATELY. The
 *  user bubble renders the moment this is called; Astra's reply streams in
 *  from the WebSocket afterwards. Never make the caller wait on the model. */
function runChat(cmd: OrvynCommand): CommandOutcome {
  startUserTurn(cmd.prompt, { mode: "chat", attachments: cmd.attachments?.map((a) => ({ path: a.name, kind: a.kind })) });
  try {
    const ws = new WebSocket(wsUrl("/ws/chat"));
    const giveUp = setTimeout(() => {
      appendAssistantDelta("\n\nCould not reach the ORVYN backend. Check Connection settings.");
      finishAssistantTurn();
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }, 15000);
    ws.onopen = () => {
      clearTimeout(giveUp);
      ws.send(
        JSON.stringify({
          task: "chat",
          history: [],
          userMessage: cmd.prompt,
          attachments: cmd.attachments ?? [],
          context: cmd.projectRoot ? { projectRoot: cmd.projectRoot, useRag: true } : { useRag: false },
        })
      );
    };
    ws.onmessage = (event) => {
      const chunk = JSON.parse(event.data);
      if (chunk.error) appendAssistantDelta(chunk.error);
      else appendAssistantDelta(chunk.delta ?? "");
      if (chunk.done) {
        finishAssistantTurn();
        ws.close();
      }
    };
    ws.onerror = () => {
      clearTimeout(giveUp);
      appendAssistantDelta("\n\nCould not reach the ORVYN backend. Check Connection settings.");
      finishAssistantTurn();
    };
  } catch (err: any) {
    appendAssistantDelta(`\n\n${err.message}`);
    finishAssistantTurn();
  }
  return { kind: "chat" };
}

async function startMission(cmd: OrvynCommand): Promise<CommandOutcome> {
  const res = await fetch(apiUrl("/agent/orchestrate"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ projectRoot: cmd.projectRoot, goal: cmd.prompt, attachments: cmd.attachments }),
  });
  const data = await res.json();
  if (!res.ok) return { kind: "error", error: data.error || "Could not start the mission" };
  return { kind: "mission", runId: data.runId };
}

async function startPlanRun(cmd: OrvynCommand): Promise<CommandOutcome> {
  const res = await fetch(apiUrl("/agent/stream/runs"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ projectRoot: cmd.projectRoot, instruction: cmd.prompt, mode: "plan", attachments: cmd.attachments }),
  });
  const data = await res.json();
  if (!res.ok) return { kind: "error", error: data.error || "Could not start the task" };
  return { kind: "run", runId: data.runId };
}

export async function submitOrvynCommand(cmd: OrvynCommand): Promise<CommandOutcome> {
  const prompt = cmd.prompt.trim();
  if (!prompt) return { kind: "error", error: "Empty command" };

  switch (classifyIntent(cmd.prompt, cmd.mode)) {
    case "chat":
      return runChat(cmd);
    case "research":
      return startPlanRun(cmd);
    case "automate":
      // No scheduler yet — run as a plan so the user gets a real, truthful
      // result instead of a dead button.
      return startPlanRun(cmd);
    default:
      return startMission(cmd);
  }
}
