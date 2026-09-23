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

export function imageKind(bytes: Uint8Array): "jpeg" | "png" | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  return null;
}
