// apps/desktop/src/renderer/composerHandoff.ts
//
// Home's "Run mission" hands its prompt to the work stream. When the run
// cannot start (for example the Local Worker is offline), the prompt and the
// reason must land in the work stream's composer, not vanish. The work stream
// may not be mounted yet when Home hands off, so the hand-off waits here.

export interface ComposerHandoff {
  text: string;
  error?: string;
}

let pending: ComposerHandoff | null = null;
export const COMPOSER_HANDOFF_EVENT = "orvyn:composer-handoff";

export function handOffToComposer(handoff: ComposerHandoff): void {
  pending = handoff;
  if (typeof document !== "undefined") document.dispatchEvent(new CustomEvent(COMPOSER_HANDOFF_EVENT));
}

export function takeComposerHandoff(): ComposerHandoff | null {
  const next = pending;
  pending = null;
  return next;
}
