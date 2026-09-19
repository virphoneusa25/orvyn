# ORVYN Architecture

ORVYN is an AI software-engineering operating system with an IDE attached.
The user gives ORVYN a goal; Astra (the orchestrator role) plans it, a task
graph is executed by specialized agents through a permission-checked Tool
Gateway, results are tested, and Astra performs a mandatory final review
before the mission is declared complete.

```
USER
 ↓
ORVYN Desktop (Electron + React + Monaco)
 ↓  HTTP / SSE / WS (localhost or remote backend)
ORVYN Backend (Express + TypeScript)
 ↓
Astra Orchestrator (MultiAgentRuntime)      ← role, model = ASTRA_MODEL_ID
 ↓
Mission → Task Graph (TaskEngine)
 ↓
Specialized Agents (coder / tester / research / git / browser / security)
 ↓
Tool Gateway → Permission Engine → sandboxed tools
 ↓
Results → tests → Review Engine (structured verdict)
 ↓
APPROVED → user   |   REJECTED → correction tasks (max 3 cycles → BLOCKED)
```

## Layers

| Layer | Location | Responsibility |
|---|---|---|
| Desktop shell | `apps/desktop/src/main` | Hardened Electron window, preload IPC bridge, project file dialogs |
| Renderer | `apps/desktop/src/renderer` | Editor, Chat/Plan/Build/Review pane, Mission Control, Agent Activity, SCM panel, Model Manager |
| API | `apps/backend/src/routes/v1.ts` | REST + SSE + WS; per-tenant auth middleware |
| Orchestration | `apps/backend/src/agent` | `MultiAgentRuntime` (Astra), `StreamingAgentRuntime` (single-agent Build runs), `TaskEngine`, `EventBus`, modes |
| Gateways | `apps/backend/src/gateway` | `ModelGateway` (role → model), `ToolGateway` (sole tool path), `PermissionEngine` (capability flags) |
| Engines | `review/`, `checkpoint/`, `context/`, `mcp/` | Review verdicts, snapshots, targeted context, MCP hub |
| Model layer | `packages/ai-core` | `AIModelProvider` interface, registry, router, adapters (OpenAI-compatible, Ollama, Mock, pending Anthropic/Google) |

## Non-negotiable invariants

1. **Agents never touch providers.** Only `modelGateway.run({ role, ... })`.
   No `if (model === "deepseek")` exists above the gateway.
2. **Agents never touch tools directly.** Registration and execution go
   through `ToolGateway`, which enforces both the user's per-tool policy
   (`allowed | ask | denied`) and the agent role's capability set
   (READ/WRITE/DELETE/EXECUTE/NETWORK/GIT/DATABASE/DEPLOYMENT/SYSTEM).
3. **Workers do not talk to each other.** Results return to Astra through
   the Task Engine; all coordination is mission state + events.
4. **Missions end with review.** The Review Engine's structured verdict
   gates completion; rejected work generates correction tasks; after 3
   cycles the mission is BLOCKED and a human decides.
5. **Nothing is faked.** Features that are not implemented render as
   **Pending** with the reason (e.g. Browser QA without Playwright,
   Anthropic/Google adapters without keys).
6. **Never auto-push.** Git mutations are `ask`-gated; checkpoints are
   created before autonomous write batches.

## Event flow

All UI surfaces subscribe to a single ordered event log per run
(`RunStore`, monotonic `sequence`, replayable via `?after=N`). The
`EventBus` adds typed mission/task/agent/test/review/checkpoint events on
top. SSE endpoint: `GET /api/v1/agent/stream/runs/:id/events`.

## Modes

- **Chat** — conversational; image intent auto-detected; not a mission, no
  review gate.
- **Plan** — Composer multi-file plan/apply with diff preview.
- **Build** — agent runs: single-agent (`/agent/stream/runs`) or full
  Astra missions (`/agent/orchestrate`).
- **Review** — latest mission's verdict, issues, and required changes.

## What is design-only today

Cloud tier (queue, isolated Docker workers, PostgreSQL/Redis, auth,
organizations, billing) is documented in `CLOUD_ARCHITECTURE.md` and
`BILLING.md` but not implemented. Local mode is the product today; the
Mission/Task/Agent interfaces were designed so the cloud worker reuses
them unchanged.
