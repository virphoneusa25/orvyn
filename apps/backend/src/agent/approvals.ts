// apps/backend/src/agent/approvals.ts
//
// An approval nobody answers must never hang a run. Before this helper, the
// approval wait was an unresolved Promise: if the user closed the workspace,
// missed the card, or restarted the app, the run stayed `awaiting_approval`
// forever — and because missions hold a MissionQueue slot for their whole
// lifetime, two zombie runs silently starved every mission after them
// (reproduced live: queue running=2, new missions queued forever, UI showing
// a permanent "Astra is analyzing…").
//
// The safe default is deny-and-continue: the tool call is denied with an
// explicit timeout message, the model is told to try another approach, and
// the run proceeds to a terminal state instead of leaking.
//
// ORVYN_APPROVAL_TIMEOUT_SEC bounds the wait (default 600 = 10 minutes;
// 0 disables the timeout entirely for unattended missions).

export function approvalTimeoutSeconds(): number {
  const raw = Number(process.env.ORVYN_APPROVAL_TIMEOUT_SEC);
  if (!Number.isFinite(raw)) return 600;
  return Math.max(0, Math.floor(raw));
}

/**
 * Races a registered approval against the timeout. `register` stores the
 * settle callback in the runtime's pending map and returns a cleanup that
 * removes it; resolveApproval/cancel call settle with the user's decision.
 * On timeout the promise resolves `{ approved: false, timedOut: true }` —
 * the caller emits the denial so the model can continue with alternatives.
 */
export function raceApprovalTimeout(
  register: (settle: (approved: boolean) => void) => () => void
): Promise<{ approved: boolean; timedOut: boolean; seconds: number }> {
  const seconds = approvalTimeoutSeconds();
  return new Promise((resolve) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const cleanup = register((approved) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      cleanup();
      resolve({ approved, timedOut: false, seconds });
    });
    if (seconds <= 0) return;
    timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      resolve({ approved: false, timedOut: true, seconds });
    }, seconds * 1000);
    timer.unref?.();
  });
}
