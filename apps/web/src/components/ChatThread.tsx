import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { streamTurn, uid, type ChatChunk } from "../lib/chatSocket";
import { attachmentRole, fileKind } from "../lib/fileKinds";
import { clock } from "../lib/format";
import { Markdown } from "../lib/markdown";
import { navigate } from "../lib/router";
import { useStore } from "../lib/store";
import { FileVisual } from "./FileVisual";
import { Icon } from "./Icons";
import { ModelPicker } from "./ModelPicker";
import { Orb } from "./Orb";
import { usePreview } from "./Preview";
import { downloadArtifact } from "../lib/api";

// One ORVYN Cloud conversation: stored on the server (reopens anywhere),
// streamed over the chat socket, metered against the account's credits.
// It is a conversation — it never starts a Desktop mission.

export interface FileRef { artifactId: string; name: string; mimeType: string }
interface Msg {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  streaming?: boolean;
  attachments?: FileRef[];
  artifacts?: FileRef[];
  error?: string;
  code?: string;
  activity?: string;
}
interface Pending { id: string; file: File; url?: string }

const MAX_FILE = 7 * 1024 * 1024;
const MAX_FILES = 8;

function toMsg(m: any): Msg | null {
  if (m.role !== "user" && m.role !== "assistant") return null;
  return {
    id: m.messageId,
    role: m.role,
    content: m.content ?? "",
    createdAt: m.createdAt,
    streaming: m.status === "streaming",
    attachments: Array.isArray(m.meta?.attachments) ? m.meta.attachments : undefined,
    artifacts: Array.isArray(m.meta?.artifacts) ? m.meta.artifacts : undefined,
  };
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error(`Couldn't read ${file.name}`));
    r.readAsDataURL(file);
  });
}

export function FileChip({ f, big }: { f: FileRef; big?: boolean }) {
  const preview = usePreview();
  const image = fileKind(f.name, f.mimeType) === "image";
  return (
    <div className="file-chip" data-testid="file-chip">
      <FileVisual artifactId={f.artifactId} name={f.name} mimeType={f.mimeType} size={30} thumbClass={big && image ? "thumb" : "thumb-sm"} />
      <div style={{ minWidth: 0, display: "grid", gap: 4 }}>
        <span className="file-chip__name" title={f.name}>{f.name}</span>
        <span className="row" style={{ gap: 6 }}>
          <button className="btn btn--sm" onClick={() => preview(f)} data-testid="chip-preview"><Icon.eye size={14} /> Preview</button>
          <button className="btn btn--sm" onClick={() => void downloadArtifact(f.artifactId, f.name)} data-testid="chip-download"><Icon.download size={14} /> Download</button>
        </span>
      </div>
    </div>
  );
}

function UpgradePrompt({ code, message }: { code?: string; message?: string }) {
  const limit = code === "CREDITS_WINDOW_5H" || code === "CREDITS_WINDOW_7D";
  return (
    <div className="upgrade-prompt" data-testid="upgrade-prompt">
      <Icon.crown size={22} />
      <div style={{ flex: 1, minWidth: 180 }}>
        <b>{limit ? "You've reached your usage window" : code === "CREDITS_ACCOUNT" ? "Your payment needs attention" : "You need more credits"}</b>
        <div className="muted" style={{ fontSize: 13 }}>{message || (limit ? "It refills on its own shortly — or upgrade for a larger allowance." : "Add credits or upgrade your plan to keep going.")}</div>
      </div>
      <button className="btn btn--sm" onClick={() => navigate("/billing#credits")}>Buy credits</button>
      <button className="btn btn--sm btn--primary" onClick={() => navigate("/billing#plans")}>Upgrade</button>
    </div>
  );
}

export function ChatThread({ sessionId, projectId, onSession, compact, placeholder, suggestions }: {
  sessionId: string | null;
  projectId?: string;
  onSession?: (id: string) => void;
  compact?: boolean;
  placeholder?: string;
  suggestions?: string[];
}) {
  const { me, model, refreshBilling, toast } = useStore();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const cancel = useRef<(() => void) | null>(null);
  const ownSession = useRef<string | null>(null);
  const stream = useRef<HTMLDivElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const area = useRef<HTMLTextAreaElement | null>(null);

  // Load the stored conversation (unless this thread just created it).
  useEffect(() => {
    if (ownSession.current && ownSession.current === sessionId) return;
    // Another conversation: stop whatever this thread was streaming.
    cancel.current?.();
    ownSession.current = null;
    if (!sessionId) { setMessages([]); return; }
    let alive = true;
    setLoading(true);
    api<{ messages: any[] }>(`/sessions/${encodeURIComponent(sessionId)}/messages`)
      .then((r) => { if (alive) setMessages(r.messages.map(toMsg).filter(Boolean) as Msg[]); })
      .catch((e) => { if (alive) { setMessages([]); toast(e.status === 404 ? "That conversation isn't available." : e.message); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [sessionId, toast]);

  // A reply still streaming when the page opened: follow the stored copy until it completes.
  useEffect(() => {
    if (!sessionId || busy || !messages.some((m) => m.streaming)) return;
    const t = window.setTimeout(async () => {
      try { const r = await api<{ messages: any[] }>(`/sessions/${encodeURIComponent(sessionId)}/messages`); setMessages(r.messages.map(toMsg).filter(Boolean) as Msg[]); } catch { /* retry next tick */ }
    }, 2500);
    return () => window.clearTimeout(t);
  }, [sessionId, busy, messages]);

  useEffect(() => { const el = stream.current; if (el) el.scrollTop = el.scrollHeight; }, [messages]);
  useEffect(() => () => { cancel.current?.(); pending.forEach((p) => p.url && URL.revokeObjectURL(p.url)); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const addFiles = (list: FileList | File[]) => {
    const next: Pending[] = [];
    for (const file of Array.from(list)) {
      if (file.size > MAX_FILE) { toast(`${file.name} is larger than 7 MB.`); continue; }
      next.push({ id: uid("p"), file, url: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined });
    }
    setPending((p) => [...p, ...next].slice(0, MAX_FILES));
  };

  const patch = (id: string, fn: (m: Msg) => Msg) => setMessages((all) => all.map((m) => (m.id === id ? fn(m) : m)));

  const send = useCallback(async (raw?: string) => {
    const content = (raw ?? text).trim();
    if ((!content && !pending.length) || busy) return;
    setBusy(true);
    const files = pending;
    setText(""); setPending([]);
    const userId = uid("msg");
    const replyId = uid("msg");
    const userMessage = content || "Here are some files.";
    setMessages((all) => [...all,
      { id: userId, role: "user", content: userMessage, createdAt: Date.now(), attachments: files.map((p) => ({ artifactId: "", name: p.file.name, mimeType: p.file.type })) },
      { id: replyId, role: "assistant", content: "", createdAt: Date.now(), streaming: true }]);
    try {
      // 1. The conversation (created on the first message).
      let sid = sessionId;
      if (!sid) {
        const r = await api<{ session: { sessionId: string } }>("/sessions", { method: "POST", body: { title: userMessage.slice(0, 70), projectId } });
        sid = r.session.sessionId;
        ownSession.current = sid;
        onSession?.(sid);
      }
      // 2. Attachments are stored with the conversation first (they reopen with it).
      const refs: FileRef[] = [];
      const forModel: { kind: "image" | "file"; name: string; b64?: string; content?: string; mediaType?: string }[] = [];
      for (const p of files) {
        const b64 = await readBase64(p.file);
        const mime = p.file.type || "application/octet-stream";
        const r = await api<{ artifact: { artifactId: string; name: string; mimeType: string } }>("/artifacts", { method: "POST", body: { name: p.file.name, kind: "upload", base64: b64, mediaType: mime, chatId: sid, projectId } });
        refs.push({ artifactId: r.artifact.artifactId, name: r.artifact.name, mimeType: r.artifact.mimeType });
        const role = attachmentRole(p.file.name, mime);
        if (role === "image") forModel.push({ kind: "image", name: p.file.name, b64, mediaType: mime });
        else if (role === "text") forModel.push({ kind: "file", name: p.file.name, content: (await p.file.text()).slice(0, 60_000) });
        else forModel.push({ kind: "file", name: p.file.name, content: `[${p.file.name} — ${mime}, ${p.file.size} bytes; binary file, contents not shown]` });
      }
      files.forEach((p) => p.url && URL.revokeObjectURL(p.url));
      patch(userId, (m) => ({ ...m, attachments: refs }));
      // 3. The reply.
      const turn = streamTurn({ sessionId: sid, userMessage, userMessageId: userId, assistantMessageId: replyId, requestedModelId: model, attachments: forModel, attachmentRefs: refs }, (c: ChatChunk) => {
        if (c.retract) patch(replyId, (m) => ({ ...m, content: "" }));
        if (c.activity) patch(replyId, (m) => ({ ...m, activity: c.activity!.status === "done" ? undefined : c.activity!.kind === "search" ? `Searching the web${c.activity!.query ? ` for “${c.activity!.query}”` : ""}…` : "Reading a page…" }));
        if (c.delta) patch(replyId, (m) => ({ ...m, content: m.content + c.delta }));
        if (c.artifacts?.length) patch(replyId, (m) => ({ ...m, artifacts: [...(m.artifacts ?? []), ...c.artifacts!] }));
        if (c.error) patch(replyId, (m) => ({ ...m, error: c.error, code: c.code ?? (/credit|allowance|limit reached|out of/i.test(c.error!) ? "CREDITS_LIMIT" : undefined) }));
        if (c.done) patch(replyId, (m) => ({ ...m, streaming: false, activity: undefined }));
      });
      cancel.current = turn.cancel;
      await turn.done;
    } catch (err: any) {
      patch(replyId, (m) => ({ ...m, error: err.message, code: err.code?.startsWith?.("CREDITS") ? err.code : undefined }));
    } finally {
      patch(replyId, (m) => ({ ...m, streaming: false, activity: undefined }));
      cancel.current = null;
      setBusy(false);
      void refreshBilling();
      area.current?.focus();
    }
  }, [text, pending, busy, sessionId, projectId, onSession, model, refreshBilling]);

  const initial = (me?.user.name || me?.user.email || "?").slice(0, 1).toUpperCase();

  return (
    <div className="chat" style={{ flex: 1, minHeight: compact ? 0 : undefined }}>
      <div className="chat__stream" ref={stream} data-testid="chat-stream">
        {loading ? <div className="empty">Loading conversation…</div> : null}
        {!loading && !messages.length && !compact ? (
          <div className="empty"><div style={{ width: 90, height: 90, margin: "0 auto", borderRadius: "50%", overflow: "hidden" }}><Orb /></div><h3>How can ORVYN help?</h3>Ask anything, attach files or images, or generate an image.</div>
        ) : null}
        {messages.map((m) => (
          <div key={m.id} className={`msg msg--${m.role}`} data-testid={`msg-${m.role}`}>
            {m.role === "assistant" ? <span className="msg__avatar"><Orb /></span> : <span className="msg__avatar msg__avatar--me">{initial}</span>}
            <div className="bubble">
              {m.activity ? <div className="activity"><Icon.search size={14} /> {m.activity}</div> : null}
              {m.role === "assistant" && m.streaming && !m.content ? <span className="typing" aria-label="ORVYN is replying"><i /><i /><i /></span> : null}
              {m.role === "assistant" ? <Markdown text={m.content} /> : <p style={{ whiteSpace: "pre-wrap" }}>{m.content}</p>}
              {m.attachments?.length ? (
                <div className="bubble__files">{m.attachments.map((f, i) => f.artifactId ? <FileChip key={f.artifactId} f={f} /> : <span key={i} className="pending-file">{f.name} · uploading…</span>)}</div>
              ) : null}
              {m.artifacts?.length ? <div className="bubble__files">{m.artifacts.map((f) => <FileChip key={f.artifactId} f={f} big />)}</div> : null}
              {m.error ? (m.code?.startsWith("CREDITS") ? <UpgradePrompt code={m.code} message={m.error} /> : <div className="error" role="alert">{m.error}</div>) : null}
              <span className="bubble__time">{clock(m.createdAt)}</span>
            </div>
          </div>
        ))}
      </div>
      {suggestions?.length && !messages.length ? (
        <div className="suggest">
          <span className="muted" style={{ fontSize: 12.5 }}>Try:</span>
          {suggestions.map((s) => <button key={s} className="chip" onClick={() => void send(s)}>{s}</button>)}
        </div>
      ) : null}
      {pending.length ? (
        <div className="composer-files">
          {pending.map((p) => (
            <span key={p.id} className="pending-file">
              {p.url ? <img src={p.url} alt="" /> : <FileVisual name={p.file.name} mimeType={p.file.type} size={22} />}
              {p.file.name}
              <button className="kebab" aria-label={`Remove ${p.file.name}`} onClick={() => { if (p.url) URL.revokeObjectURL(p.url); setPending((all) => all.filter((x) => x.id !== p.id)); }}><Icon.x size={14} /></button>
            </span>
          ))}
        </div>
      ) : null}
      {me?.viewAs ? <div className="notice notice--warn" data-testid="viewas-composer">Support view is read-only — messages can't be sent.</div> : null}
      <form className="composer" style={me?.viewAs ? { display: "none" } : undefined} onSubmit={(e) => { e.preventDefault(); void send(); }}
        onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); }}>
        <button type="button" className="composer__attach" aria-label="Attach files" onClick={() => fileInput.current?.click()}><Icon.paperclip size={20} /></button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} data-testid="file-input" />
        <textarea ref={area} rows={1} value={text} placeholder={placeholder ?? "Ask ORVYN anything…"} aria-label="Message"
          onChange={(e) => { setText(e.target.value); e.target.style.height = "auto"; e.target.style.height = `${Math.min(180, e.target.scrollHeight)}px`; }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          onPaste={(e) => { const files = Array.from(e.clipboardData.files); if (files.length) { e.preventDefault(); addFiles(files); } }} />
        {compact ? null : <ModelPicker small up />}
        {busy ? (
          <button type="button" className="composer__send" aria-label="Stop" onClick={() => cancel.current?.()}><Icon.x size={20} /></button>
        ) : (
          <button type="submit" className="composer__send" aria-label="Send" disabled={!text.trim() && !pending.length} data-testid="send"><Icon.send size={20} /></button>
        )}
      </form>
    </div>
  );
}
