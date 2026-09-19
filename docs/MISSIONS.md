# Missions

A mission is a user goal executed autonomously: plan → task graph →
agents → tests → review → verdict. Chat is not a mission; only Build
goals sent to `/api/v1/agent/orchestrate` are.

## Lifecycle

```
QUEUED → PLANNING → RUNNING → TESTING → REVIEW → COMPLETED
                        │                  │
                        │                  ├─ REWORK (correction tasks) → RUNNING
                        │                  └─ after 3 cycles → BLOCKED (human decides)
                        └─ FAILED
```

Task states: `QUEUED → READY → RUNNING → WAITING → COMPLETED | FAILED |
BLOCKED | CANCELLED`. Transitions are validated by the `TaskEngine` state
machine — an illegal transition throws.

## What a mission contains

Goal, project root, run id (event log), task graph (description, assigned
agent, dependencies, attempts, review notes), review cycles, timestamps.
Serialized live at `GET /api/v1/missions` and `/missions/:id`; Mission
Control renders exactly this.

## Execution rules

- Astra (planner model) creates the task graph; it never writes code.
- Tasks execute in dependency order; each task's worker gets only its
  role's tools and a targeted context (Context Engine), never the repo.
- A checkpoint is created before the first write-capable task
  (`checkpoint.created` event; snapshots under `.orvyn/checkpoints/`).
- Every task result is reviewed; rejection retries the task with the
  reviewer's notes injected.
- Mission-level review (Review Engine) issues the final structured verdict:

```json
{ "status": "approved | rejected", "score": 0-100,
  "blockingIssues": [], "warnings": [], "requiredChanges": [] }
```

- Rejected → correction tasks assigned to the coder; max 3 cycles, then
  the mission is BLOCKED and the UI asks the human.
- A failed mission is never silently declared successful.

## Events

Every step emits typed events on the run's event log (see
`agent/events.ts`): `mission.created/started/completed`,
`task.created/started/completed/failed`, `agent.started/tool_call/completed`,
`approval.required/resolved`, `tool.started/completed/failed`,
`test.started/completed`, `review.started/passed/rejected/approved`,
`checkpoint.created/restored`. The UI (Mission Control, Agent Activity,
Review panel) binds only to these events — there is no fabricated state.

## Verified acceptance run (2026-09-14)

`node scripts/acceptance-mission.mjs <scratch> "Create a hello-world Node.js
application …"` produced: plan (2 tasks) → coder wrote package.json +
index.js (approvals granted) → task review **rejected** first attempt →
coder reworked → review passed → tester ran `npm start` and verified
output → mission review **approved (score 100)** → COMPLETED in 63s. Files
verified on disk. The rework loop is exercised in production code, not a
demo path.

## Verified browser QA acceptance run (2026-09-14, Phase 4)

Goal: build a static page and browser-verify it. Produced: plan (2 tasks) →
coder wrote `index.html` (BALANCED profile: no write approval needed) →
task review rejected once, coder re-read the file as evidence, passed →
**browser agent** opened the page via its `file://` URL on the first
attempt (project root is now in the worker prompt), confirmed the title,
clicked `#greet`, saved two screenshots to `.orvyn/screenshots/`, and
reported zero console errors → mission review **approved (score 100)** →
COMPLETED in 107s. The same mission generated 24 metered model requests
(35,101 prompt / 2,394 completion tokens, all provider-reported) visible at
`GET /api/v1/usage`, attributed per mission/task/agent.

## Verified mission-scope + security review run (2026-09-14)

Goal: create `util.js` + `main.js`, security-review them, verify output.
On the SAFE profile with `--mission-scope`, `write_file` and `terminal`
each prompted exactly once; the mission-scope approval covered the second
`write_file` and the tester's later `node main.js` with no re-prompt (the
harness fails the run if a mission-approved tool re-prompts). The
**security agent** ran as a real task: read both files with its read-only
tool set and reported findings, which passed review. 4/4 tasks →
mission review **approved (score 100)** → COMPLETED in 89s.

Approval scopes: `POST …/approvals/:callId` accepts
`{ approved, scope: "once" | "mission" }`. Mission scope is per-run,
per-tool, cleared when the run ends, and never covers destructive shell
commands.
