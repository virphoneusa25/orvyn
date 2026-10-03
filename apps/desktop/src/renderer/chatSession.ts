// apps/desktop/src/renderer/chatSession.ts
//
// Persistent chat/conversation management. Every conversation survives
// desktop restart via window.orvyn.chats (Electron IPC → JSON file).
// Chats and missions are SEPARATE concepts: a chat may exist without a
// mission; a mission may have a linked chat.

/** One web search or page read ORION did while answering (live, then kept with the reply). */
export interface ChatActivity {
  id: string;
  /** capability: ORION needs a tool it does not have (shown as an install card). */
  kind: "search" | "read" | "capability" | "handoff";
  /** Handoff: the instruction the task starts with. */
  prompt?: string;
  status: "running" | "done" | "failed";
  query?: string;
  url?: string;
  title?: string;
  results?: number;
  found?: { url: string; title: string; snippet?: string }[];
  error?: string;
  reason?: string;
  install?: { name: string; canonicalId: string; description?: string; secrets?: string[]; freeInstall?: boolean; connect?: string; secretsProvided?: string[] };
  servers?: { name?: string; server?: string; canonicalId?: string; description?: string; freeInstall?: boolean }[];
  startedAt: number;
  endedAt?: number;
}

export interface ChatMessage {
  routing?: { provider: string; modelId: string; reason: string };
  /** Durable id, shared with the backend session's copy of this message. */
  id?: string;
  role: "user" | "assistant";
  content: string;
  /** The run this message started or answered (its work is shown by the run). */
  runId?: string;
  /** Position in the backend session (set once the backend has it). */
  sequence?: number;
  /** The web research ORION did for this reply. */
  activity?: ChatActivity[];
  mode?: string;
  attachments?: { path: string; kind: string; purpose?: string }[];
  createdAt?: number;
  imageGeneration?: import("../../../../packages/ai-core/src/imageGeneration").ImageGenerationJob;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  // Phase: Chats/History extensions
  pinned?: boolean;
  archived?: boolean;
  status?: "active" | "idle" | "archived";
  modelId?: string;
  projectRoot?: string;
  projectName?: string;
  /** Canonical WorkSession binding. The Workbench lists this workspace, not a guessed folder. */
  projectId?: string;
  workspaceId?: string;
  workspaceCreated?: boolean;
  /** The run this chat created or is linked to (if any): its newest run. */
  runId?: string;
  /** The durable backend WorkSession this chat is a view of (authoritative). */
  sessionId?: string;
  /** Every run of the session, oldest first. */
  runIds?: string[];
  /** From the backend list, until the messages themselves are loaded. */
  remoteMessageCount?: number;
  remotePreview?: string;
  /** Conversation-scoped composer settings — explicit choices made in THIS
   *  chat never alter other chats; unset values fall back to the user-level
   *  defaults stored by the composer. */
  settings?: {
    modelId?: string;
    reasoningEffort?: "auto" | "fast" | "standard" | "deep" | "max";
    permissionMode?: "ask" | "auto_read" | "auto_workspace" | "full_access";
  };
  missionId?: string;
}

type Listener = () => void;

let sessions: ChatSession[] = [];
let activeId: string | null = null;
let streaming = false;
/** The chat that owns the in-flight reply. Switching chats must not steal or block it. */
let streamingChatId: string | null = null;
let loaded = false;
const listeners = new Set<Listener>();

function emit(): void {
  listeners.forEach((l) => l());
}

function active(): ChatSession | null {
  return sessions.find((s) => s.id === activeId) ?? null;
}

// Generated images live in chat as markdown with base64 data URLs so they
// render offline — but that base64 must never be re-sent as model history:
// one image is megabytes (≈ hundreds of thousands of tokens) and permanently
// bricks the chat with context_length_exceeded. Strip it at the wire.
const DATA_URL_RE = /data:[a-zA-Z0-9.+/-]+;base64,[A-Za-z0-9+/=]{256,}/g;
const WIRE_MESSAGE_CAP = 24_000;

export function newMessageId(): string {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function toWireContent(content: string): string {
  const cleaned = content.replace(DATA_URL_RE, "[inline image omitted — saved to disk]");
  return cleaned.length > WIRE_MESSAGE_CAP ? cleaned.slice(0, WIRE_MESSAGE_CAP) + "\n…[message truncated]" : cleaned;
}

// ---- persistence -----------------------------------------------------------

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function snapshot(): { sessions: ChatSession[] } {
  return {
    sessions: sessions.map((s) => ({
      ...s,
      messages: s.messages.map((m) => ({ ...m, content: m.content.replace(DATA_URL_RE, "[image — see .orvyn/generated]") })),
    })),
  };
}

function persist(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void window.orvyn?.chats?.save(snapshot()).catch(() => {});
  }, 400);
}

/** Load persisted history once at app start. A chat started before load returns is kept. */
export async function initChatHistory(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const data = await window.orvyn?.chats?.load();
    const restored = Array.isArray(data?.sessions) ? (data.sessions as ChatSession[]) : [];
    const disk = restored.filter((s) => s && Array.isArray(s.messages));
    for (const session of disk) for (const message of session.messages) {
      if (message.imageGeneration && ["queued", "generating"].includes(message.imageGeneration.status)) {
        message.imageGeneration = { ...message.imageGeneration, status: "failed", error: "Image generation was interrupted. Retry to start it again." };
      }
    }
    const byId = new Map(disk.map((s) => [s.id, s]));
    for (const live of sessions) {
      const prev = byId.get(live.id);
      if (!prev || live.updatedAt >= prev.updatedAt) byId.set(live.id, live);
    }
    sessions = dedupeBySession([...byId.values()]);
  } catch {
    /* keep whatever is already in memory */
  }
  emit();
  persist();
}

/** One chat per backend session: keep the one with the most messages, newest on ties. */
function dedupeBySession(list: ChatSession[]): ChatSession[] {
  const keep = new Map<string, ChatSession>();
  const out: ChatSession[] = [];
  for (const s of list) {
    if (!s.sessionId) { out.push(s); continue; }
    const prev = keep.get(s.sessionId);
    if (!prev || s.messages.length > prev.messages.length || (s.messages.length === prev.messages.length && s.updatedAt > prev.updatedAt)) keep.set(s.sessionId, s);
  }
  const chosen = [...keep.values()];
  if (activeId && !out.some((s) => s.id === activeId) && !chosen.some((s) => s.id === activeId)) {
    const lost = list.find((s) => s.id === activeId);
    const replacement = lost?.sessionId ? keep.get(lost.sessionId) : undefined;
    if (replacement) activeId = replacement.id;
  }
  return [...out, ...chosen];
}

// ---- session API -----------------------------------------------------------

export function getChatMessages(): ChatMessage[] {
  return active()?.messages ?? [];
}

export function isChatStreaming(): boolean {
  return streaming;
}

export function subscribeChat(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  createdAt: number;
  messageCount: number;
  pinned: boolean;
  archived: boolean;
  status: "active" | "idle" | "archived";
  preview: string;
  projectName?: string;
  modelId?: string;
  runId?: string;
  missionId?: string;
  sessionId?: string;
  runCount?: number;
}

export function listChatSummaries(): ConversationSummary[] {
  return sessions
    .map((s) => {
      const lastMsg = s.messages[s.messages.length - 1];
      const preview = (lastMsg?.content ?? s.remotePreview ?? "").replace(DATA_URL_RE, "[image]").slice(0, 120);
      return {
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        createdAt: s.createdAt,
        messageCount: Math.max(s.messages.length, s.remoteMessageCount ?? 0),
        pinned: s.pinned === true,
        archived: s.archived === true,
        status: (s.archived ? "archived" : s.id === activeId ? "active" : "idle") as ConversationSummary["status"],
        preview,
        projectName: s.projectName,
        modelId: s.modelId,
        runId: s.runId,
        missionId: s.missionId,
        sessionId: s.sessionId,
        runCount: s.runIds?.length ?? (s.runId ? 1 : 0),
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getActiveChatId(): string | null {
  return activeId;
}

export function getActiveChat(): ChatSession | null {
  return active();
}

/** Reconnect of one chat to its backend WorkSession. Not persisted — the session record is. */
export type SessionRestoreState = "restoring" | "ready" | "failed";

export interface CanonicalWorkSession {
  sessionId: string;
  projectId: string | null;
  workspaceId: string | null;
  projectRoot: string | null;
  projectName?: string | null;
  runIds: string[];
  activeRunId: string | null;
  files?: { path: string; operation: string; runId?: string; at?: number }[];
  runs?: { runId: string; status: string; instruction?: string; createdAt?: number }[];
  artifacts?: { artifactId: string; name: string; mimeType?: string; runId?: string }[];
  preview?: { url: string; available?: boolean; runId?: string } | null;
}

const restoreState = new Map<string, SessionRestoreState>();
const restoreGen = new Map<string, number>();
const restoredView = new Map<string, CanonicalWorkSession>();

export function sessionRestoreState(chatId: string | null = activeId): SessionRestoreState {
  if (!chatId) return "ready";
  const chat = sessions.find((s) => s.id === chatId);
  if (!chat?.sessionId) return "ready";
  return restoreState.get(chatId) ?? "restoring";
}

/** An agent run may start only after this chat's WorkSession has been fetched. */
export function canStartAgentRun(chatId: string | null = activeId): boolean {
  return sessionRestoreState(chatId) === "ready";
}

/** Why Send must stay disabled, or null when a follow-up may use this chat. */
export function agentRunRestoreError(chatId: string | null = activeId): string | null {
  const chat = chatId ? sessions.find((s) => s.id === chatId) : active();
  if (!chat?.sessionId || canStartAgentRun(chat.id)) return null;
  return sessionRestoreState(chat.id) === "failed"
    ? "This conversation could not be restored. Reopen it to reconnect before sending."
    : "Restoring this conversation. Send is available once it reconnects.";
}

/** Canonical ids a follow-up run must send. Null until restore is ready. */
export function followUpRunBinding(chatId: string | null = activeId): { sessionId: string; projectId?: string; workspaceId?: string; projectRoot: string | null; previousRunId: string | null } | null {
  const chat = chatId ? sessions.find((s) => s.id === chatId) : active();
  if (!chat?.sessionId || !canStartAgentRun(chat.id)) return null;
  return {
    sessionId: chat.sessionId,
    projectId: chat.projectId,
    workspaceId: chat.workspaceId,
    projectRoot: chat.projectRoot ?? null,
    previousRunId: chat.runId ?? null,
  };
}

export function restoredWorkSession(chatId: string | null = activeId): CanonicalWorkSession | null {
  if (!chatId || sessionRestoreState(chatId) !== "ready") return null;
  return restoredView.get(chatId) ?? null;
}

export function beginSessionRestore(chatId: string): number {
  const gen = (restoreGen.get(chatId) ?? 0) + 1;
  restoreGen.set(chatId, gen);
  restoreState.set(chatId, "restoring");
  emit();
  return gen;
}

/** Write the backend session over the local cache. Stale generations are ignored. */
export function completeSessionRestore(chatId: string, gen: number, canonical: CanonicalWorkSession): boolean {
  if (restoreGen.get(chatId) !== gen) return false;
  for (const s of sessions) {
    if (s.id !== chatId && s.sessionId !== canonical.sessionId) continue;
    s.sessionId = canonical.sessionId;
    s.projectId = canonical.projectId ?? undefined;
    s.workspaceId = canonical.workspaceId ?? undefined;
    s.projectRoot = canonical.projectRoot ?? undefined;
    s.runIds = [...canonical.runIds];
    s.runId = canonical.activeRunId ?? canonical.runIds[canonical.runIds.length - 1];
  }
  restoreState.set(chatId, "ready");
  restoredView.set(chatId, canonical);
  persist();
  emit();
  return true;
}

export function failSessionRestore(chatId: string, gen: number): void {
  if (restoreGen.get(chatId) !== gen) return;
  restoreState.set(chatId, "failed");
  emit();
}

function noteSessionReady(chatId: string): void {
  if (restoreState.get(chatId) === "restoring") return;
  restoreState.set(chatId, "ready");
}

export function openChatSession(id: string): Promise<"ready" | "failed" | "none"> {
  const chat = sessions.find((s) => s.id === id);
  if (!chat) return Promise.resolve("none");
  activeId = id;
  emit();
  if (!chat.sessionId) {
    noteSessionReady(chat.id);
    return Promise.resolve("none");
  }
  const gen = beginSessionRestore(chat.id);
  if (!mirror?.restore) {
    failSessionRestore(chat.id, gen);
    return Promise.resolve("failed");
  }
  return mirror.restore(chat.sessionId, chat.id, gen);
}

/** Changes made here are mirrored to the backend session (which is authoritative). */
type SessionMirror = {
  patch(sessionId: string, patch: { title?: string; status?: string; pinned?: boolean }): void;
  remove(sessionId: string): void;
  load(sessionId: string): void;
  restore?(sessionId: string, chatId: string, gen: number): Promise<"ready" | "failed">;
};
let mirror: SessionMirror | null = null;
export function setSessionMirror(m: SessionMirror | null): void {
  mirror = m;
}

export function deleteChatSession(id: string): void {
  const gone = sessions.find((s) => s.id === id);
  if (gone?.sessionId) mirror?.remove(gone.sessionId);
  sessions = sessions.filter((s) => s.id !== id);
  if (activeId === id) activeId = null;
  persist();
  emit();
}

export function renameChatSession(id: string, title: string): void {
  const s = sessions.find((x) => x.id === id);
  if (s) {
    s.title = title.slice(0, 120) || s.title;
    s.updatedAt = Date.now();
    if (s.sessionId) mirror?.patch(s.sessionId, { title: s.title });
    persist();
    emit();
  }
}

export function pinChatSession(id: string, pinned: boolean): void {
  const s = sessions.find((x) => x.id === id);
  if (s) {
    s.pinned = pinned;
    if (s.sessionId) mirror?.patch(s.sessionId, { pinned });
    persist();
    emit();
  }
}

export function archiveChatSession(id: string, archived: boolean): void {
  const s = sessions.find((x) => x.id === id);
  if (s) {
    s.archived = archived;
    s.status = archived ? "archived" : "idle";
    if (s.sessionId) mirror?.patch(s.sessionId, { status: archived ? "archived" : "active" });
    persist();
    emit();
  }
}

export function findChatByRun(runId: string): ChatSession | null {
  return sessions.find((s) => s.runId === runId || s.runIds?.includes(runId)) ?? null;
}

/** Remember which run this conversation is, so opening the chat brings the stream back. */
export function ensureChatForRun(prompt: string, runId: string): void {
  const existing = findChatByRun(runId);
  if (existing) {
    activeId = existing.id;
    emit();
    return;
  }
  const title = prompt.replace(/\s+/g, " ").trim().slice(0, 60) || "Chat";
  const current = active();
  if (current && !current.runId) {
    current.runId = runId;
    if (current.messages.length === 0) {
      current.title = title;
      current.messages = [{ role: "user", content: prompt, createdAt: Date.now(), runId }];
    }
    current.updatedAt = Date.now();
    persist();
    emit();
    return;
  }
  const session: ChatSession = {
    id: `chat_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [{ role: "user", content: prompt, createdAt: Date.now(), runId }],
    status: "idle",
    runId,
  };
  sessions.push(session);
  activeId = session.id;
  persist();
  emit();
}

export function linkChatToRun(id: string, runId: string | undefined, missionId?: string): void {
  const s = sessions.find((x) => x.id === id);
  if (s) {
    s.runId = runId;
    if (missionId) s.missionId = missionId;
    persist();
  }
}

/** Remember the resolved workspace on the chat so reopening the conversation reconnects to it. */
export function bindChatWorkspace(chatId: string, binding: {
  sessionId?: string;
  projectId: string;
  workspaceId: string;
  projectRoot: string;
  created?: boolean;
}): void {
  const s = sessions.find((x) => x.id === chatId);
  if (!s) return;
  const created = binding.created === true;
  const unchanged = s.projectId === binding.projectId
    && s.workspaceId === binding.workspaceId
    && s.projectRoot === binding.projectRoot
    && s.workspaceCreated === created
    && (!binding.sessionId || s.sessionId === binding.sessionId);
  if (restoreState.get(s.id) === "restoring") return;
  if (binding.sessionId) s.sessionId = binding.sessionId;
  s.projectId = binding.projectId;
  s.workspaceId = binding.workspaceId;
  s.projectRoot = binding.projectRoot;
  s.workspaceCreated = created;
  noteSessionReady(s.id);
  if (unchanged) return;
  persist();
  emit();
}

export function setChatProject(id: string, projectRoot: string | null, projectName: string | null): void {
  const s = sessions.find((x) => x.id === id);
  if (s) {
    s.projectRoot = projectRoot ?? undefined;
    s.projectName = projectName ?? undefined;
    persist();
  }
}

export function setChatModel(id: string, modelId: string): void {
  const s = sessions.find((x) => x.id === id);
  if (s) {
    s.modelId = modelId;
    persist();
  }
}

export function searchChats(query: string): ConversationSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return listChatSummaries();
  return sessions
    .filter((s) => {
      if (s.title.toLowerCase().includes(q)) return true;
      if (s.projectName?.toLowerCase().includes(q)) return true;
      // Search last N messages (bounded for performance)
      for (let i = Math.max(0, s.messages.length - 20); i < s.messages.length; i++) {
        if (s.messages[i].content.toLowerCase().includes(q)) return true;
      }
      return false;
    })
    .map((s) => {
      const lastMsg = s.messages[s.messages.length - 1];
      return {
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        createdAt: s.createdAt,
        messageCount: s.messages.length,
        pinned: s.pinned === true,
        archived: s.archived === true,
        status: (s.archived ? "archived" : s.id === activeId ? "active" : "idle") as ConversationSummary["status"],
        preview: lastMsg?.content?.slice(0, 120) ?? "",
        projectName: s.projectName,
        modelId: s.modelId,
        runId: s.runId,
        missionId: s.missionId,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function startUserTurn(
  content: string,
  extra?: { mode?: string; attachments?: { path: string; kind: string; purpose?: string }[] }
): ChatMessage[] {
  let session = active();
  if (!session) {
    session = {
      id: `chat_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      title: content.slice(0, 60),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      status: "idle",
    };
    sessions.push(session);
    activeId = session.id;
  }
  const history = session.messages.map((m) => ({ role: m.role, content: toWireContent(m.content) }));
  session.messages = [...session.messages, { id: newMessageId(), role: "user", content, createdAt: Date.now(), ...extra }, { id: newMessageId(), role: "assistant", content: "", createdAt: Date.now() }];
  session.updatedAt = Date.now();
  session.status = "active";
  streaming = true;
  streamingChatId = session.id;
  emit();
  persist(); // crash-safe: the user's message is on disk before the model call
  return history;
}

/** Attach or advance the single image job owned by the active assistant turn. */
export function updateAssistantImageGeneration(messageId: string, imageGeneration: NonNullable<ChatMessage["imageGeneration"]>): void {
  const session = active();
  const message = session?.messages.find((item) => item.id === messageId && item.role === "assistant");
  if (!session || !message) return;
  message.content = "";
  message.imageGeneration = imageGeneration;
  session.updatedAt = Date.now();
  emit();
  persist();
}

/** Retry the existing image assistant message without inserting another user turn. */
export function prepareImageRetry(messageId: string, imageGeneration: NonNullable<ChatMessage["imageGeneration"]>): boolean {
  const session = active();
  const message = session?.messages.find((item) => item.id === messageId && item.role === "assistant");
  if (!session || !message || streaming) return false;
  message.content = "";
  message.imageGeneration = { ...imageGeneration, status: "queued", error: undefined, assets: undefined };
  session.updatedAt = Date.now();
  session.status = "active";
  streaming = true;
  streamingChatId = session.id;
  emit();
  persist();
  return true;
}

/**
 * Regenerate: the active chat's last reply is replaced by a new one to the
 * same question. Returns what the new turn needs, or null when the chat does
 * not end with a finished question → reply pair (or a reply is streaming).
 */
export function beginRegenerate(): { history: ChatMessage[]; user: ChatMessage; reply: ChatMessage; replacedId?: string } | null {
  const session = active();
  if (!session || streaming) return null;
  const n = session.messages.length;
  const last = session.messages[n - 1];
  const question = session.messages[n - 2];
  if (!last || !question || last.role !== "assistant" || question.role !== "user" || last.runId || question.runId) return null;
  const history = session.messages.slice(0, n - 2).map((m) => ({ role: m.role, content: toWireContent(m.content) }));
  const reply: ChatMessage = { id: newMessageId(), role: "assistant", content: "", createdAt: Date.now() };
  session.messages = [...session.messages.slice(0, n - 1), reply];
  session.updatedAt = Date.now();
  streaming = true;
  streamingChatId = session.id;
  emit();
  persist();
  return { history, user: question, reply, replacedId: last.id };
}

/** A search or page read arrived (or finished) for the reply being streamed. */
export function upsertAssistantActivity(a: ChatActivity): void {
  const session = sessions.find((s) => s.id === streamingChatId) ?? active();
  const last = session?.messages[session.messages.length - 1];
  if (!session || !last || last.role !== "assistant") return;
  const list = [...(last.activity ?? [])];
  const i = list.findIndex((x) => x.id === a.id);
  if (i >= 0) list[i] = a; else list.push(a);
  last.activity = list;
  session.updatedAt = Date.now();
  emit();
  persist();
}

/** ORION withdrew what it said so far (it researches first): clear the reply text. */
export function retractAssistantText(): void {
  const session = sessions.find((s) => s.id === streamingChatId) ?? active();
  const last = session?.messages[session.messages.length - 1];
  if (!session || !last || last.role !== "assistant") return;
  last.content = "";
  emit();
}

export function appendAssistantDelta(delta: string): void {
  const session = sessions.find((s) => s.id === streamingChatId) ?? active();
  if (!delta || !session || session.messages.length === 0) return;
  const last = session.messages[session.messages.length - 1];
  if (last.role !== "assistant") return;
  last.content += delta;
  session.updatedAt = Date.now();
  emit();
  persist();
}

export function setAssistantRouting(routing: NonNullable<ChatMessage["routing"]>): void {
  const session = sessions.find((s) => s.id === streamingChatId) ?? active();
  const last = session?.messages[session.messages.length - 1];
  if (!last || last.role !== "assistant") return;
  last.routing = routing;
  emit();
  persist();
}

export function finishAssistantTurn(): void {
  streaming = false;
  const session = sessions.find((s) => s.id === streamingChatId) ?? active();
  streamingChatId = null;
  if (session) session.updatedAt = Date.now();
  persist();
  emit();
}

/** The chat new work goes into: the active one, or a new one titled by the first request. */
export function ensureActiveChat(title: string): ChatSession {
  let session = active();
  if (!session) {
    session = {
      id: `chat_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      title: title.split("\n")[0]!.slice(0, 60) || "New conversation",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      status: "active",
    };
    sessions.push(session);
    activeId = session.id;
    emit();
  }
  return session;
}

/** A run started from a chat: that chat now follows the durable session and run.
 *  Bound by chat id, because the user may switch chats while the request is in flight. */
export function bindChatToRun(chatId: string, sessionId: string | undefined, runId: string | undefined, message?: ChatMessage): void {
  const session = sessions.find((s) => s.id === chatId);
  if (!session) return;
  if (sessionId) session.sessionId = sessionId;
  noteSessionReady(session.id);
  // The run's instruction is a message of the conversation (the backend stored it with the same id).
  if (message?.id && !session.messages.some((m) => m.id === message.id)) session.messages = [...session.messages, message];
  if (runId) {
    session.runId = runId;
    session.runIds = [...(session.runIds ?? []).filter((r) => r !== runId), runId];
  }
  session.updatedAt = Date.now();
  if (!session.archived) session.status = "active";
  flushChats();
  emit();
}

export interface BackendSessionLike {
  sessionId: string;
  title: string;
  runIds: string[];
  activeRunId: string | null;
  status: string;
  pinned: boolean;
  projectRoot: string | null;
  projectId?: string | null;
  workspaceId?: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount?: number;
  lastMessage?: string;
}

export interface BackendMessageLike {
  messageId: string;
  role: "user" | "assistant" | "system";
  content: string;
  runId: string | null;
  sequence: number;
  mode: string | null;
  status?: "complete" | "streaming";
  meta?: { activity?: ChatActivity[] } & Record<string, unknown>;
  createdAt: number;
}

/**
 * The backend's messages are the conversation. They replace the cached ones
 * (same ids); a local message the backend does not have yet (sent while
 * offline, or from before messages were stored) is kept in time order.
 */
export function applyBackendMessages(sessionId: string, list: BackendMessageLike[]): void {
  const chat = sessions.find((s) => s.sessionId === sessionId);
  if (!chat || !list.length) return;
  // Never replace a reply that is still streaming into this window.
  if (streamingChatId === chat.id) return;
  const backend: ChatMessage[] = [...list].sort((a, b) => a.sequence - b.sequence).map((m) => ({
    id: m.messageId,
    role: m.role === "user" ? "user" : "assistant",
    content: m.content,
    routing: m.meta?.routing as ChatMessage["routing"],
    runId: m.runId ?? undefined,
    sequence: m.sequence,
    mode: m.mode ?? undefined,
    activity: Array.isArray(m.meta?.activity) ? m.meta!.activity : undefined,
    createdAt: m.createdAt,
  }));
  const ids = new Set(backend.map((m) => m.id));
  const same = (a: ChatMessage, b: ChatMessage) => a.role === b.role && a.content.trim() === b.content.trim();
  const extra = chat.messages.filter((m) => (m.id ? !ids.has(m.id) : !backend.some((b) => same(b, m))) && (m.content.trim() || m.role === "user"));
  // Backend order is the sequence. Messages from before messages were stored
  // (no id) come first; ones the backend has not received yet come last.
  const merged = [...extra.filter((m) => !m.id), ...backend, ...extra.filter((m) => m.id)];
  const before = JSON.stringify(chat.messages.map((m) => [m.id, m.content]));
  chat.messages = merged;
  chat.remoteMessageCount = list.length;
  if (JSON.stringify(merged.map((m) => [m.id, m.content])) !== before) { persist(); emit(); }
}

/**
 * The backend's sessions are the truth; this file is a cache. Every backend
 * session appears as a chat (created here if this computer never saw it), and
 * the backend's title, runs and dates win.
 */
export function mergeBackendSessions(list: BackendSessionLike[]): void {
  let changed = false;
  for (const b of list) {
    let local = sessions.find((s) => s.sessionId === b.sessionId);
    if (!local) {
      local = {
        id: `chat_${b.sessionId}`,
        sessionId: b.sessionId,
        title: b.title,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
        messages: [],
        status: b.status === "archived" ? "archived" : "idle",
      };
      sessions.push(local);
    }
    local.title = b.title || local.title;
    local.runIds = b.runIds;
    local.runId = b.activeRunId ?? b.runIds[b.runIds.length - 1] ?? local.runId;
    local.updatedAt = Math.max(local.updatedAt, b.updatedAt);
    local.pinned = b.pinned;
    local.archived = b.status === "archived";
    if (b.projectRoot) local.projectRoot = b.projectRoot;
    if (b.projectId) local.projectId = b.projectId;
    if (b.workspaceId) local.workspaceId = b.workspaceId;
    if (typeof b.messageCount === "number") local.remoteMessageCount = b.messageCount;
    if (typeof b.lastMessage === "string") local.remotePreview = b.lastMessage;
    changed = true;
  }
  if (changed) { persist(); emit(); }
}

/** Opening a run re-enters its conversation: the chat that owns the run, or a fresh one. */
export function openChatForRun(runId: string): ChatSession | null {
  const owner = sessions.find((s) => s.runId === runId || s.runIds?.includes(runId)) ?? null;
  if (owner) openChatSession(owner.id);
  else newChat();
  return owner;
}

export function getChat(id: string): ChatSession | null {
  return sessions.find((s) => s.id === id) ?? null;
}

/** Writes the cache now (used when a session is bound, and when the app closes). */
export function flushChats(): void {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  void window.orvyn?.chats?.save(snapshot()).catch(() => {});
}

/** Test hook: empty the in-memory cache the way a fresh process starts. */
export function resetChatStoreForTests(): void {
  sessions = [];
  activeId = null;
  loaded = false;
  streaming = false;
  streamingChatId = null;
  restoreState.clear();
  restoreGen.clear();
  restoredView.clear();
}

/** Test hook: the on-disk cache after a restart, before the backend is asked. */
export function seedChatCacheForTests(list: ChatSession[]): void {
  sessions = list.map((s) => ({ ...s, messages: s.messages.map((m) => ({ ...m })) }));
  activeId = null;
  restoreState.clear();
  restoreGen.clear();
  restoredView.clear();
}

export function newChat(): void {
  activeId = null;
  if (!streamingChatId) streaming = false;
  persist();
  emit();
}

/** Backward-compatible export for older components. */
export function listChatSessions(): { id: string; title: string; updatedAt: number; count: number; runId?: string }[] {
  return listChatSummaries().map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, count: c.messageCount, runId: c.runId }));
}


/** Reads the active conversation's composer settings (conversation value →
 *  caller-supplied user default → undefined). */
export function getActiveChatSettings(): NonNullable<ChatSession["settings"]> {
  return active()?.settings ?? {};
}

/** Persists one composer setting into the ACTIVE conversation. */
export function setActiveChatSetting(
  key: keyof NonNullable<ChatSession["settings"]>,
  value: string
): void {
  const session = active();
  if (!session) return; // no conversation yet — user defaults still apply via the composer
  const current: NonNullable<ChatSession["settings"]> = { ...(session.settings ?? {}) };
  // All settings values are flat strings (modelId, reasoningEffort, permissionMode)
  (current as Record<string, string>)[key] = value;
  session.settings = current;  session.updatedAt = Date.now();
  persist();
  emit();
}
