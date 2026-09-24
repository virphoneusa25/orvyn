// When the Desktop pane should pull frames, and how to recognize one.
//
// The session can already say Running while `live` is missing on an older
// backend. A JPEG/PNG body is a frame even when Content-Type is empty —
// dropping those responses left the pane on "Connecting to Desktop…".

export interface StreamSession {
  live?: boolean;
  status?: string;
}

const STREAM_STATUSES = new Set(["ready", "user_control", "agent_control", "running"]);

export function desktopMayAutoStart(opts: {
  userStopped: boolean;
  alreadyStarted: boolean;
  hasProject: boolean;
  sandboxAvailable: boolean;
  hasSession: boolean;
  starting: boolean;
  /** The Desktop tab is on screen. A hidden tab never starts a desktop. */
  visible?: boolean;
}): boolean {
  if (opts.userStopped || opts.alreadyStarted) return false;
  if (opts.visible === false) return false;
  if (!opts.hasProject || !opts.sandboxAvailable) return false;
  if (opts.hasSession || opts.starting) return false;
  return true;
}

export function sessionCanStream(session: StreamSession | null | undefined): boolean {
  if (!session) return false;
  if (session.status === "starting" || session.status === "error" || session.status === "ended") return false;
  if (session.live === true) return true;
  return STREAM_STATUSES.has(session.status ?? "");
}

/** How long a frame request may take. Cloud capture is a docker exec plus the JPEG upload. */
export const FRAME_REQUEST_MS = 20_000;

/** Cover the picture only after this long with no successful frame. */
export const FRAME_STALE_MS = 15_000;

/**
 * A single slow capture must not hide a desktop that is already on screen.
 * The overlay is for a stream that has actually stopped.
 */
export function shouldCoverFrame(lastFrameAt: number, now: number): boolean {
  if (!lastFrameAt) return true;
  return now - lastFrameAt > FRAME_STALE_MS;
}

export interface PointerPoint {
  x: number;
  y: number;
}

export interface MoveGate {
  inFlight: boolean;
  pending: PointerPoint | null;
}

/** Keep only the newest pointer position. A move already on the wire is not followed by a queue. */
export function gatePointerMove(gate: MoveGate, point: PointerPoint): { gate: MoveGate; send: PointerPoint | null } {
  if (gate.inFlight) return { gate: { inFlight: true, pending: point }, send: null };
  return { gate: { inFlight: true, pending: null }, send: point };
}

/** After a move finishes, send the position the pointer has since moved to. */
export function releasePointerMove(gate: MoveGate): { gate: MoveGate; send: PointerPoint | null } {
  if (gate.pending) return { gate: { inFlight: true, pending: null }, send: gate.pending };
  return { gate: { inFlight: false, pending: null }, send: null };
}

export function imageKind(bytes: Uint8Array): "jpeg" | "png" | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  return null;
}

/**
 * Reads the backend's live picture stream (Server-Sent Events). Calls
 * onFrame with each JPEG. Resolves with why it ended:
 *  - "unsupported": this backend or desktop cannot stream — poll instead;
 *  - "ended": the desktop stopped or the stream was closed;
 *  - "failed": network trouble — try again shortly.
 */
export async function readDesktopStream(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  onFrame: (jpeg: Uint8Array) => void,
): Promise<"unsupported" | "ended" | "failed"> {
  let res: Response;
  try {
    res = await fetch(url, { headers, cache: "no-store", signal });
  } catch {
    return "failed";
  }
  const type = res.headers.get("content-type") ?? "";
  if (res.status === 404 && !type.includes("json")) return "unsupported"; // backend without /stream
  if (!res.ok) return res.status === 404 ? "ended" : "failed";
  if (!type.includes("text/event-stream") || !res.body) return "unsupported";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return "ended";
      buf += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const ev = parseSseBlock(block);
        if (ev.event === "frame" && ev.data) onFrame(base64ToBytes(ev.data));
        else if (ev.event === "end") return /unsupported/.test(ev.data) ? "unsupported" : "ended";
      }
    }
  } catch {
    return signal.aborted ? "ended" : "failed";
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

export function parseSseBlock(block: string): { event: string; data: string } {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return { event, data: data.join("\n") };
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
