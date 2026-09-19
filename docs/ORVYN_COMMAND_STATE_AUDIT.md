# ORVYN Command State Audit — 2026-09-19

## Symptom

Typing "hi" on Home produced:

```
Run started · multitask · hi
Thinking... (astra)
Astra produced no tasks.        ← run.error
mission.created
Mission Plan: ERROR + "Working — step 1"
Recent Missions: 0 missions
```

## Root causes (three, compounding)

1. **Mode-first, not intent-first.** The Home composer's persisted default
   mode was `code`; `submitOrvynCommand.classify()` only consulted its
   conversational heuristic when mode === `auto` (which the UI never sent —
   no AUTO chip existed). With mode `code`, ANY text — "hi" included — went
   straight to `/agent/orchestrate`. Mission created before intent was
   known: exactly the inverted architecture.
2. **"No tasks" treated as planning failure.** `MultiAgentRuntime` throws
   "Astra produced no tasks" → `run.error` → run status `error`. For a
   conversational goal this is NO_TASK_NEEDED, not PLANNING_FAILED — the
   backend had no such distinction.
3. **Derivative UI disagreed with primary state.** `MissionPlan` fallback
   rendered "Working — step N" from `thinking` events even when the run had
   already terminal-errored (badge said ERROR, body said Working); Live
   Activity printed raw event names (`mission.created`) and model aliases
   (`ci:gpt-6-astra`) as primary text; Recent Missions polls `/missions`
   independently, so a just-failed 0-task mission raced the poll (and a
   failed planning mission is easy to read as "no missions").

## Fixes applied

| Cause | Fix |
|---|---|
| Mission before intent | `classify()` is now intent-first for every mode: AUTO classifies fully; explicit modes are honored for executable work but a strong-conversational guard (greetings/tiny-talk) reroutes to CHAT even in CODE — "hi" can never reach `/agent/orchestrate` again. AUTO chip added and is the fresh default (order: AUTO CODE SERVER RESEARCH DEPLOY AUTOMATE). |
| NO_TASK_NEEDED vs PLANNING_FAILED | `MultiAgentRuntime`: when Astra's plan yields no tasks, the run now completes with a conversational explanation and the mission is COMPLETED — no `run.error`. A genuine JSON/planning *failure* still errors. |
| UI disagreement | `MissionPlan` never shows "Working" for a terminal run without a plan (states derived from the same run events); Live Activity + activity cards display human labels ("Mission created", "Astra is reviewing…") with raw names/models demoted to tooltips; Recent Missions refresh interval tightened after submission. |
| Terminal ANSI garbage | renderer now strips/translates ANSI before display; the banner no longer embeds escape codes. |

## Canonical flow (implemented)

USER → `submitOrvynCommand` → intent router → CHAT (chat session + WS) /
TASK-RESEARCH (plan run) / MISSION (orchestrate) → Build attaches to the
returned runId → Mission Plan / Live Activity / Recent Missions / status
bar all derive from RunStore events + `/missions`.
