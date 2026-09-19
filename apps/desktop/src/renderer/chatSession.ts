export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  mode?: string;
  attachments?: { path: string; kind: string; purpose?: string }[];
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

type Listener = () => void;

let sessions: ChatSession[] = [];
let activeId: string | null = null;
let streaming = false;
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

function persist(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // Strip inline base64 before writing: a handful of generated images would
    // otherwise balloon the history file to hundreds of MB.
    const slim = sessions.map((s) => ({
      ...s,
      messages: s.messages.map((m) => ({ ...m, content: m.content.replace(DATA_URL_RE, "[image — see .orvyn/generated]") })),
    }));
    void window.orvyn?.chats?.save({ sessions: slim }).catch(() => {});
  }, 400);
}

/** Load persisted history once at app start. Safe to call repeatedly. */
export async function initChatHistory(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const data = await window.orvyn?.chats?.load();
    const restored = Array.isArray(data?.sessions) ? (data.sessions as ChatSession[]) : [];
    sessions = restored.filter((s) => s && Array.isArray(s.messages) && s.messages.length > 0);
  } catch {
    sessions = [];
  }
  emit();
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

export function listChatSessions(): { id: string; title: string; updatedAt: number; count: number }[] {
  return sessions
    .map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, count: s.messages.length }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getActiveChatId(): string | null {
  return activeId;
}

export function openChatSession(id: string): void {
  if (streaming) return;
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
    };
    sessions.push(session);
    activeId = session.id;
  }
  const history = session.messages.map((m) => ({ role: m.role, content: toWireContent(m.content) }));
  session.messages = [...session.messages, { role: "user", content, ...extra }, { role: "assistant", content: "" }];
  session.updatedAt = Date.now();
  streaming = true;
  emit();
  return history;
}

export function appendAssistantDelta(delta: string): void {
  const session = active();
  if (!delta || !session || session.messages.length === 0) return;
  const last = session.messages[session.messages.length - 1];
  if (last.role !== "assistant") return;
  last.content += delta;
  emit();
}

export function finishAssistantTurn(): void {
  streaming = false;
  const session = active();
  if (session) session.updatedAt = Date.now();
  persist();
  emit();
}

export function newChat(): void {
  activeId = null;
  streaming = false;
  persist();
  emit();
}
