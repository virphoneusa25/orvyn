import { api } from "./api";

// One chat turn over the ORVYN chat socket. The socket is opened with a
// one-minute single-use ticket (the session token never rides a URL).

export interface ChatChunk {
  delta?: string;
  done?: boolean;
  error?: string;
  code?: string;
  retract?: boolean;
  heartbeat?: boolean;
  type?: string;
  activity?: { id: string; kind: string; status?: string; query?: string; url?: string; title?: string };
  artifacts?: { artifactId: string; name: string; mimeType: string }[];
}

export interface TurnInput {
  sessionId: string;
  userMessage: string;
  userMessageId: string;
  assistantMessageId: string;
  requestedModelId: string;
  attachments: { kind: "image" | "file"; name: string; b64?: string; content?: string; mediaType?: string }[];
  attachmentRefs: { artifactId: string; name: string; mimeType: string }[];
}

export function streamTurn(input: TurnInput, onChunk: (c: ChatChunk) => void): { cancel: () => void; done: Promise<void> } {
  let socket: WebSocket | null = null;
  let cancelled = false;
  const done = (async () => {
    const { ticket } = await api<{ ticket: string }>("/auth/ws-ticket", { method: "POST", body: {} });
    const proto = location.protocol === "https:" ? "wss" : "ws";
    await new Promise<void>((resolve, reject) => {
      socket = new WebSocket(`${proto}://${location.host}/ws/chat?ticket=${encodeURIComponent(ticket)}`);
      let sent = false;
      let finished = false;
      const finish = () => { if (!finished) { finished = true; resolve(); try { socket?.close(); } catch { /* closed */ } } };
      socket.onmessage = (ev) => {
        let c: ChatChunk;
        try { c = JSON.parse(String(ev.data)); } catch { return; }
        if (c.type === "connection.ready") {
          if (cancelled) return finish();
          sent = true;
          socket!.send(JSON.stringify({
            task: "chat", surface: "cloud",
            sessionId: input.sessionId,
            userMessage: input.userMessage,
            userMessageId: input.userMessageId,
            assistantMessageId: input.assistantMessageId,
            userCreatedAt: Date.now(),
            requestedModelId: input.requestedModelId,
            reasoningEffort: "auto",
            attachments: input.attachments,
            attachmentRefs: input.attachmentRefs,
            context: { mode: "ask", useRag: false },
          }));
          return;
        }
        if (c.heartbeat) return;
        onChunk(c);
        if (c.done) finish();
      };
      socket.onerror = () => { if (!finished) { finished = true; reject(new Error("The connection to ORVYN dropped. Try again.")); } };
      socket.onclose = () => { if (!finished) { finished = true; sent ? resolve() : reject(new Error("Couldn't connect to ORVYN.")); } };
    });
  })();
  return { cancel: () => { cancelled = true; try { (socket as WebSocket | null)?.close(); } catch { /* closed */ } }, done };
}

export function uid(prefix: string): string {
  const b = new Uint8Array(9);
  crypto.getRandomValues(b);
  return `${prefix}_${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}
