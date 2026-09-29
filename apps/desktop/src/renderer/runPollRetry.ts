// Run-event poll retry pacing.
//
// The SSE stream hands over to polling on error; polling used to give up on
// the first non-OK response, which stranded active chats on
// "ORION is working…" while the run finished server-side. A failing poll now
// retries gently while it is still this chat's run.

export function pollRetryDelayMs(status: number): number {
  // 404: a restarted backend forgot the run (in-memory store) — slowest.
  if (status === 404) return 2500;
  // 401/5xx: deploy window or auth blip — the backend usually recovers.
  return 1500;
}
