// apps/desktop/src/renderer/chatSession.ts
//
// Persistent chat/conversation management. Every conversation survives
// desktop restart via window.orvyn.chats (Electron IPC → JSON file).
// Chats and missions are SEPARATE concepts: a chat may exist without a
// mission; a mission may have a linked chat.

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  mode?: string;
  attachments?: { path: string; kind: string; purpose?: string }[];
  createdAt?: number;
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
  /** The run this chat created or is linked to (if any). */
  runId?: string;
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
    const byId = new Map(disk.map((s) => [s.id, s]));
    for (const live of sessions) {
      const prev = byId.get(live.id);
      if (!prev || live.updatedAt >= prev.updatedAt) byId.set(live.id, live);
    }
    sessions = [...byId.values()];
  } catch {
    /* keep whatever is already in memory */
  }
  emit();
  persist();
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
}

export function listChatSummaries(): ConversationSummary[] {
  return sessions
    .map((s) => {
      const lastMsg = s.messages[s.messages.length - 1];
      const preview = lastMsg?.content?.replace(DATA_URL_RE, "[image]").slice(0, 120) ?? "";
      return {
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        createdAt: s.createdAt,
        messageCount: s.messages.length,
        pinned: s.pinned === true,
        archived: s.archived === true,
        status: (s.archived ? "archived" : s.id === activeId ? "active" : "idle") as ConversationSummary["status"],
        preview,
        projectName: s.projectName,
        modelId: s.modelId,
        runId: s.runId,
        missionId: s.missionId,
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

export function openChatSession(id: string): void {
  if (sessions.some((s) => s.id === id)) {
    activeId = id;
    emit();
  }
}

export function deleteChatSession(id: string): void {
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
    persist();
    emit();
  }
}

export function pinChatSession(id: string, pinned: boolean): void {
  const s = sessions.find((x) => x.id === id);
  if (s) {
    s.pinned = pinned;
    persist();
    emit();
  }
}

export function archiveChatSession(id: string, archived: boolean): void {
  const s = sessions.find((x) => x.id === id);
  if (s) {
    s.archived = archived;
    s.status = archived ? "archived" : "idle";
    persist();
    emit();
  }
}

export function linkChatToRun(id: string, runId: string | undefined, missionId?: string): void {
  const s = sessions.find((x) => x.id === id);
  if (s) {
    s.runId = runId;
    if (missionId) s.missionId = missionId;
    persist();
  }
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
  session.messages = [...session.messages, { role: "user", content, createdAt: Date.now(), ...extra }, { role: "assistant", content: "", createdAt: Date.now() }];
  session.updatedAt = Date.now();
  session.status = "active";
  streaming = true;
  streamingChatId = session.id;
  emit();
  persist(); // crash-safe: the user's message is on disk before the model call
  return history;
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

export function finishAssistantTurn(): void {
  streaming = false;
  const session = sessions.find((s) => s.id === streamingChatId) ?? active();
  streamingChatId = null;
  if (session) session.updatedAt = Date.now();
  persist();
  emit();
}

export function newChat(): void {
  activeId = null;
  if (!streamingChatId) streaming = false;
  persist();
  emit();
}

/** Backward-compatible export for older components. */
export function listChatSessions(): { id: string; title: string; updatedAt: number; count: number }[] {
  return listChatSummaries().map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, count: c.messageCount }));
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
