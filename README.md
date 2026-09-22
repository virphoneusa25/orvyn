# ORVYN

**Your autonomous software engineering team.**

ORVYN is an AI software-engineering operating system with an IDE attached.
Give it a goal; Astra (the orchestrator) plans it into a task graph,
specialized agents implement and test it through a permission-checked Tool
Gateway, and a mandatory review gates completion. Models are pluggable —
DeepSeek, OpenAI, any OpenAI-compatible host, or fully local Ollama.

```
USER → ORVYN → ASTRA ORCHESTRATOR → MISSION → TASK GRAPH
     → AGENTS (coder / tester / research / git / browser / security)
     → TOOL GATEWAY (permissions, sandbox, approvals)
     → TESTS → ASTRA REVIEW → approved | rework (max 3 cycles) → USER
```

## What works today (verified, not mocked)

- **Missions end-to-end.** `POST /api/v1/agent/orchestrate` runs a real
  plan → code → test → review pipeline. Verified live: a hello-world
  mission where Astra planned 2 tasks, the coder wrote real files (with
  user approvals), the task review *rejected* the first attempt, the coder
  reworked it, the tester verified `npm start` output, and the mission
  review approved with score 100. See `scripts/acceptance-mission.mjs` to
  reproduce.
- **36 gateway tools** — filesystem, ripgrep search, symbols, terminal,
  background processes, diagnostics/typecheck/tests/lint, git (status →
  commit), fetch/web-search, image generation, MCP, Playwright browser QA
  (bundled Chromium with system Chrome/Edge fallback, screenshots, console
  error collection). All permission-checked per agent role.
- **Usage metering** — every model request produces a server-side usage
  event (provider-reported tokens only, never estimates), attributed to
  mission/task/agent. `GET /api/v1/usage`.
- **Autonomy profiles** — SAFE / BALANCED / AUTONOMOUS (Settings), composed
  with per-mode permissions and per-tool overrides; destructive commands
  always require approval.
- **Model Gateway** — role → task → model routing. `ASTRA_MODEL_ID` picks
  the orchestrator model; `DEEPSEEK_API_KEY` enables the DeepSeek coding
  worker; Ollama for local; Mock fallback so the IDE always boots.
  Anthropic/Google are typed Pending adapters, never faked.
- **IDE** — Electron (hardened: contextIsolation, sandbox, no Node in
  renderer), Monaco editor, tabs, explorer, Ctrl+P/Ctrl+K, inline edit,
  streaming chat with natural-language image generation, Qdrant-backed
  hybrid project intelligence (structural chunks, tenant-scoped vectors,
  incremental reindex). See `docs/PROJECT_INTELLIGENCE.md`.
- **Intelligence UI** — center chat/stream plus one IDE Workbench
  (Changes / Desktop / Browser plus dynamic Preview, Files, Diff, Terminal,
  Artifact, and Review tabs). Follow ORION switches the active tab only.
  Desktop is a live Chromium session with Take Control / Return to ORION.
  Mission Control; Agent Activity bottom panel; Source Control with git +
  checkpoint restore/compare.
- **Checkpoints** — automatic snapshot before autonomous write batches;
  create/restore/compare/delete via API and SCM panel. Never auto-push.
- **Deployable** — `docker compose up -d` gives backend + automatic HTTPS
  (Caddy) on any Linux VM. See `docs/OVH_DEPLOYMENT.md`.

## Running it

```bash
npm install
npm run backend:dev    # Express API on :4570
npm run desktop:dev    # Electron + Vite
```

Copy `.env.example` → `.env` to configure model providers. With no
provider configured, a clearly-labeled Mock adapter answers so the UI is
explorable offline.

## Acceptance harness

```bash
node scripts/acceptance-mission.mjs <projectRoot> "<goal>"
```

Starts a real mission, streams every event, and auto-approves tool calls
(add `--deny <tool>` to exercise the denial path). Exit code 0 only when
the mission completes with an approved review.

## Documentation

| Doc | Contents |
|---|---|
| `docs/ORVYN_ARCHITECTURE_AUDIT.md` | Current-state audit: what exists, problems, migration path |
| `docs/ARCHITECTURE.md` | System layers and invariants |
| `docs/AGENTS.md` | Agent roster, capabilities, mission flow |
| `docs/MODEL_GATEWAY.md` | Provider-independent model routing |
| `docs/TOOL_GATEWAY.md` | Tool inventory, permissions, sandbox |
| `docs/MISSIONS.md` | Mission/task lifecycle and review gates |
| `docs/SECURITY.md` | Electron hardening, agent containment, known gaps |
| `docs/LOCAL_MODE.md` / `docs/CLOUD_MODE.md` | Local product today; cloud design |
| `docs/CLOUD_ARCHITECTURE.md` / `docs/BILLING.md` | SaaS tier design (not yet implemented) |
| `docs/OVH_DEPLOYMENT.md` | Production deployment on OVH |

## Explicitly NOT implemented yet

- Run event logs are in-memory (missions, usage, profile, tool overrides,
  and user-added models persist to `~/.orvyn/data/<tenant>.db` via
  node:sqlite; requires Node ≥ 22.5)
- Organizations/RBAC, email verification, OAuth, billing (per-user
  accounts with isolated tenants ARE implemented — Settings → Account)
- Cloud tier: job queue, isolated Docker workers, WebSocket fanout
- Tree-sitter/LSP (`list_symbols` is regex v1; `find_references` pending).
  Hybrid search + structural symbol chunking are implemented.

Pending features are visible as **Pending** in the UI with the reason —
nothing is faked.

## Workspace layout

```
apps/backend      Express API, agent runtimes, gateways, engines
apps/desktop      Electron main + React renderer (Monaco)
packages/ai-core  Model providers, registry, router
scripts/          acceptance-mission.mjs harness
docs/             architecture + deployment docs
infrastructure/   Caddy config, OVH deployment assets
```
