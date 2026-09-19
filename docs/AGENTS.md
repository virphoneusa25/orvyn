# ORVYN Agents

Agents are roles, not processes. Each role maps to a model task through the
Model Gateway and to a tool subset + capability set through the Tool
Gateway. The roster is served live by `GET /api/v1/agents` — status is
computed, never hard-coded.

| Role | Label | Model task | Capabilities | Status |
|---|---|---|---|---|
| orchestrator | Astra | planner (+ reviewer for verdicts) | READ, GIT | ready |
| coder | Coding Agent | executor | READ, WRITE, DELETE, EXECUTE, GIT, NETWORK | ready |
| tester | Testing Agent | executor | READ, EXECUTE, NETWORK | ready |
| research | Research Agent | chat | READ, NETWORK | ready |
| git | Git Agent | executor | READ, GIT, WRITE (git mutations only — its tool list is `git_*`) | ready |
| browser | Browser QA Agent | executor | READ, NETWORK, EXECUTE | ready (Playwright installed; launches bundled Chromium, falling back to system Chrome/Edge) |
| security | Security Agent | reviewer | READ, GIT | ready (read-only review: inspects code and diffs, reports severity-rated findings; never edits or executes) |

## How a mission runs

1. Astra (planner model) decomposes the goal into tasks with `agent`
   assignments and dependencies (`TaskEngine`).
2. Each task runs in `MultiAgentRuntime.runWorker` on the assigned role's
   model, with only that role's tools offered to the model.
3. Tool calls stream as events; `ask` tools pause for user approval.
4. Every finished task is reviewed (reviewer model). Rejected → the task is
   retried with the review notes injected (`attempts` increments).
5. When all tasks settle, the Review Engine issues the mission verdict.
   Rejected → correction tasks; 3 cycles → BLOCKED.

## Astra's contract

Astra plans, delegates, monitors, and reviews. It does not edit files —
its capability set has no WRITE, and the Permission Engine enforces that
even if a prompt tried to make it code.

## Adding an agent

1. Add the role to `AgentRole` and its capabilities in
   `gateway/PermissionEngine.ts`.
2. Add its descriptor in `agent/Agent.ts` (`defaultRoster`), with an honest
   `pending` status until `execute` is real.
3. Add its tool filter + prompt in `agent/MultiAgentRuntime.ts`.
4. Let Astra know it may delegate to it (the delegatable-agent list in the
   orchestrator prompt is built from the roster).
