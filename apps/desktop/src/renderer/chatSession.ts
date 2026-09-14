export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

type Listener = () => void;

let messages: ChatMessage[] = [];
let streaming = false;
const listeners = new Set<Listener>();

function emit(): void {
  listeners.forEach((l) => l());
}

export function getChatMessages(): ChatMessage[] {
  return messages;
}

export function isChatStreaming(): boolean {
  return streaming;
}

export function subscribeChat(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function startUserTurn(content: string): ChatMessage[] {
  messages = [...messages, { role: "user", content }, { role: "assistant", content: "" }];
  streaming = true;
  emit();
  return messages.slice(0, -2).map((m) => ({ role: m.role, content: m.content }));
}

export function appendAssistantDelta(delta: string): void {
  if (messages.length === 0) return;
  const copy = [...messages];
  const last = copy[copy.length - 1];
  copy[copy.length - 1] = { role: "assistant", content: last.content + delta };
  messages = copy;
  emit();
}

export function finishAssistantTurn(): void {
  streaming = false;
  emit();
}

export function newChat(): void {
  messages = [];
  streaming = false;
  emit();
}
