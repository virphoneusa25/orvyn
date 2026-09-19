# ORVYN Architecture Audit

Date: 2026-09-14
Scope: full repository inspection against the ORVYN master product specification
(AI Software Engineering Operating System — local + cloud, multi-agent, mission-based).

---

## 1. Repository shape (actual)

```
viride/                          npm workspaces monorepo (not pnpm)
├── apps/
│   ├── backend/                 Express + TypeScript API + agent runtime (port 4570)
│   │   └── src/
│   │       ├── agent/           StreamingAgentRuntime, MultiAgentRuntime (Astra),
│   │       │                    TaskEngine, EventBus, Agent interface, modes, events
│   │       ├── ai/              Orchestrator (chat), tool implementations, tool registration
│   │       ├── gateway/         ModelGateway, ToolGateway, PermissionEngine
│   │       ├── review/          ReviewEngine (structured JSON verdicts)
│   │       ├── checkpoint/      CheckpointEngine (.orvyn/checkpoints snapshots)
│   │       ├── context/         ContextEngine v1 (ripgrep + git diff + symbols)
│   │       ├── mcp/             McpHub (.orvyn/mcp.json → mcp_list/mcp_call)
│   │       ├── indexing/        IndexService (embeddings RAG)
│   │       ├── composer/        Plan/apply multi-file edits
│   │       ├── images/          ImageService
│   │       ├── tenancy/         TenantManager (per-tenant service graph)
│   │       ├── middleware/      API-key auth (single-tenant when ORVYN_API_KEY unset)
│   │       └── routes/          /api/v1 REST + SSE + WS
│   └── desktop/                 Electron 31 + React + Monaco
│       └── src/
│           ├── main/main.ts     frameless window, contextIsolation, sandbox, preload IPC
│           └── renderer/        App shell, ActivityBar, Editor, Chat/Plan/Build/Review tabs,
│                                MissionControl, GitScmPanel, BottomPanel (Agent Activity),
│                                ReviewPanel, ModelManager, Settings
├── packages/
│   ├── ai-core/                 Provider-agnostic model layer: AIModelProvider,
│   │                            ModelRegistry, ModelRouter, adapters (OpenAI-compatible,
│   │                            Ollama, Mock, Pending Anthropic/Google)
│   └── shared/                  shared types
├── docs/                        this audit + deployment docs
├── infrastructure/docker/       Caddyfile (reverse proxy)
├── docker-compose.yml           backend + Caddy HTTPS
└── .env.example                 model provider + API key template
```

Build system: `tsc` per workspace + Vite for the renderer. Package manager: npm
workspaces. No test suite or linter exists yet (typecheck is the current gate).
Persistence: in-memory per tenant (missions, runs, tasks) + on-disk `.orvyn/`
(rules, config, checkpoints, mcp.json). No database. No authentication beyond
a single shared API key. Desktop talks to the backend over HTTP/SSE/WS on
localhost:4570.

## 2. What already satisfies the master spec

| Spec area | Status | Where |
|---|---|---|
| Model Gateway, provider-independent | Done | `packages/ai-core` + `apps/backend/src/gateway/ModelGateway.ts`. Role → router task (`planner/executor/reviewer/chat/vision`) → registered model. No agent code names a provider. |
| Orchestrator model configurable | Done | `ORCHESTRATOR_MODEL` env override maps onto planner + reviewer tasks (`ModelService`). `ASTRA_MODEL_ID` is honored as an alias (see §5). |
| DeepSeek coding worker | Done | `DEEPSEEK_API_KEY` registers `deepseek-v4-flash`/`-pro` via the OpenAI-compatible adapter and points `executor` at flash. Fallback chain: Cheaper Inference / OpenAI / Ollama / Mock. |
| Anthropic/Google | Pending adapters | Typed `PendingProviderAdapter` classes; UI shows Pending. Not fake. |
| Tool Gateway + Permission Engine | Done | 35 tools registered through `ToolGateway`; capability flags READ/WRITE/DELETE/EXECUTE/NETWORK/GIT enforced per agent role; per-tool `allowed/ask/denied` user policy survives re-registration. |
| Agent Runtime + roster | Done | orchestrator, coder, tester, research, git real; browser (Playwright not installed) and security marked Pending with reasons. |
| Task Engine / Missions | Done | `TaskEngine.ts`: mission + task state machines (QUEUED…BLOCKED), dependency-ordered execution. |
| Event Bus | Done | `EventBus` wraps `RunStore`; mission/task/agent/test/review/checkpoint events stream over existing SSE. |
| Review Engine | Done | Structured JSON verdict (status/score/blockingIssues/warnings/requiredChanges); rejected → correction tasks; 3-cycle cap → mission BLOCKED. |
| Checkpoints | Done | `CheckpointEngine`: create/restore/compare/delete snapshots under `.orvyn/checkpoints/`; auto-checkpoint before coder WRITE batches; never auto-push. |
| Context Engine | v1 done | Targeted context via `search_code` + `list_symbols` + git diff + IndexService semantic hits. Tree-sitter/LSP: pending interfaces. |
| MCP | Done (hub) | `McpHub` reads `.orvyn/mcp.json`; agents only see generic `mcp_list`/`mcp_call` through the gateway. |
| Intelligence UI | Done | Right pane Chat/Plan/Build/Review; left bar Explorer/Search/SCM/Agents/Models/Settings; Mission Control; Agent Activity bottom panel; Git SCM panel with checkpoints. Live event data only. |
| Electron security | Done | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, minimal preload bridge, no Node in renderer. |
| Approval system | Done | `ask` tools pause the run; UI offers Allow Once / Allow for Mission / Deny. Mission scope auto-approves that tool for the rest of the run; destructive commands always re-prompt. |

## 3. Problems found

1. **No persistence.** Missions, runs, checkpoint metadata, and tool
   permissions live in process memory; a backend restart loses history.
   Checkpoint file snapshots survive (on disk) but their index does not.
2. ~~**Single-tenant auth.**~~ Partially resolved: per-user accounts with
   scrypt passwords, hashed 30-day sessions, login rate limiting, and
   per-user tenant isolation are implemented (`/api/v1/auth/*`, shared
   `auth.db`). Still missing: email verification, password reset, OAuth,
   organizations/RBAC.
3. **No test suite.** The gate is `tsc` + manual launch. The spec demands
   unit/integration tests; the testing *tools* exist (run_tests etc.) but the
   repo has nothing for them to run against itself.
4. ~~**Permission profiles.**~~ Resolved: SAFE/BALANCED/AUTONOMOUS profiles
   are implemented and persisted, and approvals support the "Allow for
   Mission" scope (destructive commands excepted).
5. **No usage events.** Model requests are not metered per mission/agent.
6. **No cloud tier.** No queue, no workers, no sandbox, no object storage.
   Local mode is the only mode. This is by design at this stage but must be
   kept API-compatible (same Mission/Task interfaces) when added.
7. **`list_symbols` regex noise** (matches control keywords as methods
   occasionally) — acceptable v1, replace with tree-sitter later.
8. **Docs drift.** README still describes the pre-Intelligence scaffold.

## 4. Migration path (recommended, incremental)

1. **Now (local product hardening):** acceptance-test the full mission loop
   (plan → code → test → review → rework) against a real scratch project;
   fix what breaks; write the documentation set; ship a deployable Docker
   image (exists: docker-compose + Caddy) with OVH instructions.
2. **Persistence:** introduce SQLite (local) behind a storage interface so the
   same repositories can be re-implemented on PostgreSQL for cloud. Store
   missions, tasks, runs, usage events, checkpoints metadata.
3. **Usage metering:** emit a usage event per model request inside
   `ModelGateway.run` (single choke point already exists).
4. **Permission profiles:** add SAFE/BALANCED/AUTONOMOUS to `.orvyn/config.json`
   + "Allow for mission" approval scope keyed by missionId.
5. **Cloud tier (Phases 7–9 of the spec):** new `apps/cloud` service reusing
   `packages/ai-core` and the backend's engine modules (they have no Express
   dependency); Redis queue; Docker worker image that runs the existing agent
   runtime headless against a cloned repo.
6. **Auth/billing (Phase 10):** accounts + sessions are done (local
   AuthService on SQLite); remaining: orgs/memberships, email flows, OAuth,
   Stripe on top of the persisted server-side usage records.

## 5. Preserve / refactor / new

**Preserve as-is (working, do not rewrite):**
- `apps/desktop/src/main/main.ts` (hardened Electron shell), Monaco editor,
  tabs, explorer, TitleBar, chat + image intercept, ResizablePanel.
- `packages/ai-core` adapters and router.
- All `gateway/`, `agent/`, `review/`, `checkpoint/`, `context/`, `mcp/`
  modules added in the Intelligence build.

**Refactor when the need is real (not preemptively):**
- `apps/backend/src/routes/v1.ts` (500+ lines — split by resource when the
  cloud API lands).
- `ModelService` env-seeding block → declarative provider config file.
- Rename note: spec names `ASTRA_MODEL_ID`; code reads `ORCHESTRATOR_MODEL`.
  Both are now accepted (`ASTRA_MODEL_ID` wins if both set).

**New components required (in order):**
- `storage/` repositories (SQLite → PostgreSQL) — missions, usage, checkpoints.
- Usage metering in `ModelGateway`.
- Permission profiles + mission-scoped approvals.
- `apps/cloud` (API + queue + worker) — interfaces shared with local runtime.
- Auth/orgs/billing services.
- Tree-sitter/LSP context providers (replace regex symbols).

## 6. Non-negotiables carried forward

- Everything an agent does goes through the Tool Gateway; no agent imports
  a tool implementation or an MCP client directly.
- No provider names in agent code — only `modelGateway.run({ role, ... })`.
- No fake data anywhere in the UI: pending features render as **Pending**
  with the reason, or not at all.
- Never auto-push. Never bypass `ask` permissions. Checkpoint before
  autonomous WRITE/DELETE batches.
