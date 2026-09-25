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

import { apiUrl, authHeaders, getConnectionConfig, isCloudBackend } from "./connection";
import { noteActiveRunId } from "./connectionRuntime";
import { startUserTurn, appendAssistantDelta, finishAssistantTurn, ensureActiveChat, bindChatToRun, getActiveChat } from "./chatSession";
import { createSession } from "./sessionsApi";
import { wsUrl } from "./connection";
import { backendModeForIntent, belongsInCloudStorage, classifyIntent, CommandMode, looksLikeGeneratedFileRequest } from "./orvynIntent";
import type { Attachment } from "./components/AttachmentBar";

export type { CommandMode } from "./orvynIntent";
export type CommandSource = "HOME" | "CHAT" | "NEW_TASK" | "QUICK_ACTION" | "MISSION";

export interface OrvynCommand {
  prompt: string;
  mode: CommandMode;
  source: CommandSource;
  projectRoot: string | null;
  attachments?: Attachment[];
  previousRunId?: string | null;
  /** "auto" or a concrete registry model id; honored per run. */
  requestedModelId?: string;
  /** Composer reasoning effort — honored by models that declare support. */
  reasoningEffort?: "auto" | "fast" | "standard" | "deep" | "max";
  /** Composer access mode — run-scoped ToolGateway permission mapping. */
  permissionMode?: "ask" | "auto_read" | "auto_workspace" | "full_access";
  /** Where tools run. Separate from mode. */
  executionTarget?: "auto" | "local_host" | "local_sandbox" | "ovh_worker";
}

export type CommandOutcome =
  | { kind: "chat" }
  | { kind: "mission"; runId: string }
  | { kind: "run"; runId: string }
  | { kind: "error"; error: string };

/** Starts a chat turn into the shared session — returns IMMEDIATELY. The
 *  user bubble renders the moment this is called; ORION's reply streams in
 *  from the WebSocket afterwards. Never make the caller wait on the model. */
function runChat(cmd: OrvynCommand): CommandOutcome {
  const history = startUserTurn(cmd.prompt, { mode: "chat", attachments: cmd.attachments?.map((a) => ({ path: a.name, kind: a.kind })) });
  // Every chat is a durable backend WorkSession, even before it starts a run.
  const chat = getActiveChat();
  if (chat && !chat.sessionId) {
    void createSession(chat.title, cmd.projectRoot).then((s) => { if (s && !chat.sessionId) bindChatToRun(chat.id, s.sessionId, undefined); });
  }
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
          history,
          userMessage: cmd.prompt,
          attachments: cmd.attachments ?? [],
          requestedModelId: cmd.requestedModelId,
          reasoningEffort: cmd.reasoningEffort,
          context: cmd.projectRoot ? { projectRoot: cmd.projectRoot, useRag: true } : { useRag: false },
        })
      );
    };
    ws.onmessage = (event) => {
      let chunk;
      try { chunk = JSON.parse(event.data); } catch { appendAssistantDelta("Could not read the server response. Please retry."); finishAssistantTurn(); ws.close(); return; }
      if (chunk.error) appendAssistantDelta(chunk.error);
      else appendAssistantDelta(chunk.delta ?? "");
      if (chunk.done) {
        finishAssistantTurn();
        ws.close();
      }
    };
    ws.onclose = () => { clearTimeout(giveUp); finishAssistantTurn(); };
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
  const chat = ensureActiveChat(cmd.prompt);
  const res = await fetch(apiUrl("/agent/orchestrate"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ sessionId: chat.sessionId, projectRoot: cmd.projectRoot, goal: cmd.prompt, attachments: cmd.attachments, requestedModelId: cmd.requestedModelId, reasoningEffort: cmd.reasoningEffort, permissionMode: cmd.permissionMode }),
  });
  const data = await res.json();
  if (!res.ok) return { kind: "error", error: data.error || "Could not start the mission" };
  if (data.runId) noteActiveRunId(String(data.runId));
  bindChatToRun(chat.id, data.sessionId, data.runId);
  return { kind: "mission", runId: data.runId };
}

async function startPlanRun(cmd: OrvynCommand, mode: "agent" | "plan" | "research" = "agent"): Promise<CommandOutcome> {
  const forcedCloud = cmd.executionTarget === "ovh_worker" || (cmd.mode === "server" && cmd.executionTarget !== "local_host" && cmd.executionTarget !== "local_sandbox");
  const cloudBackend = isCloudBackend(getConnectionConfig().backendUrl);
  const remoteRoot = cmd.projectRoot || "/opt/orvyn/workspaces";
  const executionTarget = cmd.executionTarget
    ?? (forcedCloud && cloudBackend ? "ovh_worker" : "auto");
  // The run belongs to the active chat's durable session (a new chat gets one).
  const chat = ensureActiveChat(cmd.prompt);
  const res = await fetch(apiUrl("/agent/stream/runs"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      projectRoot: cmd.projectRoot,
      remoteProjectRoot: cmd.projectRoot ?? remoteRoot,
      executionTarget,
      composerMode: cmd.mode,
      executionLocation: executionTarget === "ovh_worker" ? "OVH_WORKER" : undefined,
      instruction: cmd.prompt,
      mode,
      attachments: cmd.attachments,
      previousRunId: cmd.previousRunId,
      sessionId: chat.sessionId,
      requestedModelId: cmd.requestedModelId,
      reasoningEffort: cmd.reasoningEffort,
      permissionMode: cmd.permissionMode,
    }),
  });
  const data = await res.json();
  if (!res.ok) return { kind: "error", error: data.error || "Could not start the task" };
  if (data.runId) noteActiveRunId(String(data.runId));
  bindChatToRun(chat.id, data.sessionId, data.runId);
  return { kind: "run", runId: data.runId };
}

/** The hidden built-in workspace the desktop falls back to when no folder is
 *  open. It is NOT a project — running missions against it produced the
 *  "health check can't find the project" confusion. Execution-class requests
 *  against it are refused with guidance instead of silently working there. */
export function isBuiltInWorkspace(root: string | null): boolean {
  if (!root) return false;
  const norm = root.replace(/\\/g, "/").toLowerCase();
  return norm.includes("appdata") && norm.includes("@orvyn") && norm.endsWith("workspace");
}

export async function submitOrvynCommand(cmd: OrvynCommand): Promise<CommandOutcome> {
  const prompt = cmd.prompt.trim();
  const host = new URL(getConnectionConfig().backendUrl).hostname;
  const generatedFile = looksLikeGeneratedFileRequest(prompt);
  // Generated deliverables (logos, PDFs, Word files) go to Cloud file storage.
  // Everything else keeps the open folder, so "Create test.txt" is written on
  // this computer and not silently moved to ORVYN Cloud.
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host) && belongsInCloudStorage(prompt)) {
    cmd = { ...cmd, projectRoot: null };
  }
  if (!prompt) return { kind: "error", error: "Empty command" };

  switch (classifyIntent(cmd.prompt, cmd.mode)) {
    case "chat":
      return runChat(cmd);
    case "research":
      return startPlanRun(cmd, "research");
    case "automate":
      return startPlanRun(cmd, backendModeForIntent("automate") ?? "agent");
    default: {
      // Generated files use virtual workspace + artifact storage — a local
      // repo is an execution option, not a prerequisite.
      if (isBuiltInWorkspace(cmd.projectRoot) && !generatedFile) {
        return {
          kind: "error",
          error:
            "I need a project workspace before I can inspect or modify code — the current workspace is ORVYN's built-in scratch area, not your project. Open a project folder (Projects → Open Project) and send the request again.",
        };
      }
      return cmd.source === "MISSION" ? startMission(cmd) : startPlanRun(cmd, "agent");
    }
  }
}
