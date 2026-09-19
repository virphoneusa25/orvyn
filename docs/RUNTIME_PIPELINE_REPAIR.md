# ORVYN Runtime Pipeline Repair — 2026-09-19

Functional repair of the conversation/streaming/agent event pipeline, per the
runtime-repair spec. No UI redesign; the approved layouts are unchanged.

## Reproduction (before touching anything)

The spec's exact test prompt was submitted through the live backend
(`POST /api/v1/agent/orchestrate`) and the run store inspected directly.

Findings — measured, not guessed:

1. **The "stall" was two zombie runs starving the mission queue.**
   `MissionQueue` (concurrency 2) had `running: 2` with one run in
   `awaiting_approval` for 6+ minutes. Cause: the approval wait was an
   unresolved `Promise` — no timeout. If the user never answers the approval
   card (closed the workspace, missed it, restarted the app), the mission and
   its queue slot hang forever. Every later mission queues behind it while
   the UI shows a permanent "Astra is analyzing your request…".
2. **The "hi" title leak was renderer conversation identity.** WorkStream
   renders the singleton chat session's messages and derives its title from
   the first chat user message. Starting a mission (or re-opening one) does
   not detach the active chat session, so an unrelated "hi" conversation
   supplied the workspace title and its messages.
3. **Queued missions lied as RUNNING.** A mission waiting for a queue slot
   emitted only a `thinking` note; the run status stayed `running`.
4. Provider errors were already terminal and truthful (verified: a dead-key
   `429 insufficient_quota` run ends in `run.error`; retry policy already
   treats quota 429s as permanent).

## Fixes

| Fix | Where |
|---|---|
| Approval timeout — deny-and-continue after `ORVYN_APPROVAL_TIMEOUT_SEC` (default 600, 0 disables); `approval.resolved` carries the timeout reason; the model is told to continue with an alternative | `apps/backend/src/agent/approvals.ts` (new), wired into both `MultiAgentRuntime` and `StreamingAgentRuntime` |
| Truthful queue state — new `queued` run status + `run.queued` event with position; status flips to `running` only when the slot is acquired | `agent/events.ts`, `MultiAgentRuntime.start/orchestrate` |
| Cancelling a queued mission is terminal immediately (`run.cancelled` "Stopped by user before it started"); the orchestrate guard never runs a cancelled mission when its slot frees | `MultiAgentRuntime.cancel/orchestrate` |
| Conversation identity — starting work or re-opening a run detaches the active chat session; the workspace title derives from the run's own instruction, never an unrelated thread | `App.tsx`, `WorkStream.tsx` |
| Status mapping — renderer tracks `run.queued`/`run.started`; QUEUED badge (amber) in the header; queue card in the center stream; poll continues for queued runs | `useAgentRun.ts`, `WorkStream.tsx`, `AgentActivityList.tsx`, `MissionPlan.tsx` |
| Auto-scroll respects the reader — follows only while at the bottom; scrolling up pins and offers "↓ Jump to latest" | `WorkStream.tsx` |

## Verification

- Unit: `approvals.test.ts` (4 tests) — timeout parse, user-decision wins +
  cleanup, silence denies + cleanup, late decision is a no-op. Full suite
  42 pass / 0 fail.
- E2E `scripts/smoke-streaming.mjs`, run in the spec's order:
  1. simple chat streams over WS and creates NO mission
  2. tool task runs the full loop (approval → tool → completion → file on disk)
  3. an unplannable mission terminates (never permanent RUNNING)
  4. the spec's exact health-check mission reaches a terminal state, with
     unanswered approvals auto-denied (live models)
  5. queue truthfulness: full slots → `run.queued` at position; queued
     mission cancellable before it starts (verified live: `run.queued` →
     `run.cancelled`, status `cancelled`)

## Already true (kept, not rebuilt)

Run event protocol with monotonic sequences and `?after=` replay, SSE +
poll fallback + event-id dedupe in one stream client (`useAgentRun`), cancel
via AbortController + pending-approval resolution, the full tool-calling loop
with per-role capability gates, diff-preview approvals, one-click Undo via
pre-run checkpoints, usage metering with run/mission budgets, transient-only
model retries, right context panel driven by the same event bus.

## Pass 2 — remaining acceptance items (same day)

| Gap from the spec | Fix |
|---|---|
| No provider-call timeout — a hung connection froze "Astra is analyzing…" forever (Part 22) | `agent/modelTimeout.ts`: every generate call runs under `ORVYN_MODEL_CALL_TIMEOUT_MS` (default 5 min, 0 disables), composed with the run's cancel signal so Stop still wins; a timeout surfaces as a model error, not silence |
| Run history died with the backend process (Parts 25/47/65) | `RunStore` now appends every event to `<data>/runs-<tenant>/<runId>.jsonl` as it streams and replays the newest logs at boot — finished runs' history and `?after=` resume survive a restart (unit-tested with a store-restart test) |
| No SSE liveness (Part 23) | The events endpoint sends a `: hb` comment every 15s while a run is live (verified in the smoke suite) |
| Silent stalls (Part 37) | The workspace tracks time since the last event; an active run quiet for 30s shows "Still working… (no new activity for Ns)" |
| No Retry (Parts 18/38) | Failed/stopped runs get "↻ Retry this request" — submits the SAME instruction as a NEW run; history is never overwritten |
| No observability (Part 54) | Dev-only Run Inspector (runId, status, event count/sequence, model, tokens, turns, last event) — tree-shaken out of production builds (verified absent from app.asar) |

Verified: 54/55 tests pass (1 pre-existing skip); smoke suite adds heartbeat + the
spec's Phoenix multi-turn test — the live model recalled the codename from
client-supplied history, same conversation, no mission.

In-flight runs still die with the process (durable execution needs the cloud
tier's queue); on boot they replay as their last persisted status.

## Known limits (unchanged, honest)

Run state is in-memory: a backend restart loses live-run replay (finished-run
history in the renderer persists). Durable event persistence arrives with the
commercial data layer. Follow-up messages during an active run start a new
turn in the same workspace rather than being queued.
