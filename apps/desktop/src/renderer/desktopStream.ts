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
