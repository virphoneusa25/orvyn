# VirIDE

**Your Code. Your Models. Your AI.**

An AI-native coding IDE, architected so the AI layer is a pluggable gateway
to models you host and control — Ollama, vLLM, llama.cpp, or any custom
HTTP model server. No vendor SDK is required anywhere in the stack.

This is a real, runnable **Phase 1 + early Phase 2/3** scaffold, not a mockup.
Backend and renderer both build and boot successfully (verified below).

## Architecture

```
VirIDE Desktop (Electron + React + Monaco)
        │  IPC (secure preload bridge — no Node in renderer)
        ▼
Electron Main Process (file system, project root sandboxing)

Desktop Renderer  ──HTTP/WS──▶  Backend (Express + TS)
                                    │
                                AI Orchestrator
                                (context → prompt → route → model → response)
                                    │
                                Model Gateway (packages/ai-core)
                                    │
                        ┌───────────┼───────────────┐
                        ▼           ▼               ▼
                    OllamaAdapter  OpenAICompatible  MockAdapter
                                    Adapter (vLLM,     (zero-config
                                    llama.cpp, custom  fallback)
                                    HTTP servers)
```

## What's implemented right now

- **`packages/ai-core`** — provider-agnostic `AIModelProvider` interface,
  `ModelRegistry`, `ModelRouter` (task → model, with user overrides), and
  three adapters: Ollama, a generic OpenAI-compatible wire-format adapter
  (covers vLLM / llama.cpp server / most custom model APIs), and a Mock
  adapter so the IDE runs with zero external dependencies.
- **`apps/backend`** — Express server, versioned REST API (`/api/v1/models`,
  `/api/v1/tools`, `/api/v1/chat/completions`), WebSocket streaming chat
  (`/ws/chat`), an AI Orchestrator that builds context-aware prompts
  (current file, selection, `.viride/rules.md`), and a Tool framework with
  a permission model (`allowed` / `ask` / `denied`) plus three real,
  project-sandboxed tools: `read_file`, `list_directory`, `search_files`,
  `write_file` (defaults to `ask`).
- **`apps/desktop`** — Electron shell with a locked-down `BrowserWindow`
  (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`),
  a preload bridge exposing only `project.open/listDirectory/readFile/writeFile`,
  and a React renderer: activity-bar layout, file explorer, Monaco editor,
  and a streaming AI chat panel wired to the backend over WebSocket.
- **`.viride/`** — project config convention: `rules.md` (instructions
  auto-included in every AI request), `models.json`, `config.json`
  (tool permission defaults).

## Verified working (this session)

```
✓ packages/ai-core   — tsc build clean
✓ apps/backend        — tsc build clean, boots, responds to:
                         GET  /api/v1/health
                         GET  /api/v1/models
                         POST /api/v1/chat/completions
                         WS   /ws/chat  (streamed chunks, confirmed end-to-end)
✓ apps/desktop/main    — tsc build clean (main + preload)
✓ apps/desktop/renderer— vite build clean (React + Monaco bundle, 162kB)
```

Electron's GUI window itself can't be launched headlessly in this
environment — that's an environment limitation, not a code gap. Run
`npm run desktop:dev` from a normal desktop OS to see the window.

## Running it

```bash
npm install

# Terminal 1 — backend
npm run backend:dev
# → http://localhost:4570

# Terminal 2 — desktop app
npm run desktop:dev
```

Click **Open Folder**, pick a project, click a file to open it in Monaco,
and use the AI Assistant panel on the right — it streams from the backend,
which currently routes to the zero-config Mock adapter. To point it at a
real model, add one via `POST /api/v1/models` (or edit `.viride/models.json`
and wire it into `ModelService`), e.g. for a local Ollama install:

```json
{
  "id": "llama3", "name": "Llama 3", "provider": "ollama",
  "endpoint": "http://localhost:11434", "contextWindow": 8192,
  "maxOutputTokens": 2048, "defaultTemperature": 0.2, "defaultTopP": 1,
  "streaming": true,
  "capabilities": { "chat": true, "code": true, "agent": true, "tools": true,
                     "vision": false, "embeddings": true, "completion": true }
}
```

## Model Manager (new)

Click the 🧠 icon in the Activity Bar. It's a full model CRUD UI backed by
real endpoints, not a mock:

- **List** — every registered model with a live status dot (from
  `GET /api/v1/models/health`, polled every 15s) and its capabilities.
- **Add / Edit** — full form for id, name, provider, endpoint, API key,
  context window, max output tokens, temperature, top-p, streaming, and
  every capability flag (chat/code/agent/tools/vision/embeddings/completion).
  `POST /api/v1/models` to add, `PUT /api/v1/models/:id` to edit.
- **Test Model** — round-trips a real short prompt through the model
  (`POST /api/v1/models/:id/test`) and shows latency + response snippet,
  or the actual error if the endpoint is unreachable — verified above with
  both a real unreachable-Ollama failure and a successful mock response.
- **Delete** — `DELETE /api/v1/models/:id`.
- **Routing** — per-task (chat/code/completion/embedding/agent/vision)
  default-model dropdowns, backed by `GET/POST /api/v1/routing`. Falls back
  automatically to the first model with the matching capability if a task
  has no override.

## Composer, Agent, and RAG (new)

- **Composer** (`ComposerPanel.tsx`, `/api/v1/composer/plan|apply`) — describe
  a multi-file change, get a real diff per file (LCS-based), select which
  files to apply, apply selectively or all at once. Verified end-to-end
  against a real sample project: plan → diff → apply → files confirmed on
  disk with correct content.
- **Agent** (`AgentPanel.tsx`, `/api/v1/agent/runs`, `.../approve`) — a real
  tool-calling loop: the model can call `read_file`/`list_directory`/
  `search_files` (auto-executed, `allowed`), or `write_file`/`terminal`/
  `git_commit` (pauses for approval, `ask`), with destructive-command
  detection on `terminal`. Verified end-to-end both ways: approved → tool
  executes, file written to disk; denied → model is told, run completes
  gracefully, nothing written.
- **RAG / Codebase Indexing** (`SearchPanel.tsx`, `/api/v1/index/build`,
  `/api/v1/search/semantic`) — scanner → chunker → embedder → vector store
  pipeline. Ships with a zero-dependency `HashingEmbedder` (bag-of-words,
  L2-normalized cosine similarity) and `InMemoryVectorStore` so it works
  with no external services; `ModelEmbedder` and the `VectorStore`
  interface are there for swapping in a real embedding model / Qdrant /
  pgvector / Chroma later without touching calling code. Verified: indexed
  a sample project, exact-term queries correctly ranked the right file
  top. Documented limitation: this is *lexical* similarity, not learned
  semantic similarity — verbose natural-language queries can misrank
  short, term-dense files over longer, more relevant ones. A real
  embedding model fixes this; the interface is ready for it.
- Chat panel has a **RAG toggle** — when on and the index is `ready`, the
  Orchestrator injects the top-ranked chunks as context automatically.

## Deploying to a cloud server + Windows client (new)

See **`docs/DEPLOYMENT.md`** for the full walkthrough. Summary:

- `apps/backend/Dockerfile` + `docker-compose.yml` + `infrastructure/docker/Caddyfile`
  give you a one-command (`docker compose up -d`) deployment on any Linux
  cloud VM, with automatic HTTPS (Caddy/Let's Encrypt) and an optional
  self-hosted Ollama container.
- Real API-key auth (`VIRIDE_API_KEY`) now gates every route except
  `/health`, and the WebSocket chat stream — verified working (401 on
  missing/wrong key, 200/stream on correct key).
- The desktop app's backend URL + API key are configurable via a new
  **Connection** settings panel (⚙️ in the Activity Bar), persisted to
  disk — point the same Windows `.exe` at `localhost` or your cloud
  domain with no rebuild.
- `apps/desktop/package.json` has an `electron-builder` NSIS config
  (`npm run dist:win`) for producing a real Windows installer.
- **Honestly scoped**: this is one shared API key (not per-user accounts),
  no rate limiting, and in-memory backend state — fine for you or a small
  trusted team on one server, not yet a multi-tenant production service.
  See `docs/DEPLOYMENT.md` for exactly what that means and what Phase 7
  would add.

## Explicitly NOT implemented yet (do not assume these work)

```
TODO — Postgres persistence (models/projects/conversations/agent sessions/index currently in-memory)
TODO — Full auth (per-user accounts/RBAC), multi-tenancy, rate limiting (currently: one shared API key)
TODO — Real embedding model wired in by default (currently: hashing bag-of-words fallback)
TODO — Inline Ctrl+K editing (select code, ask for an edit, get an inline diff)
TODO — Terminal panel, Git panel (the Agent has terminal/git *tools*; there's no standalone UI panel for them yet)
TODO — Background/worker-queued indexing for large repos (currently runs synchronously per request)
MOCK — the seeded "viride-mock" model is not a real model; its Composer/Agent behavior is scripted for demo/testing, not real reasoning
```

## Phase plan (per the build spec)

1. **Foundation** ← you are here (this scaffold)
2. AI Model Gateway ← ai-core + adapters done; health-check UI still TODO
3. AI Chat ← chat panel + streaming done; conversation persistence TODO
4. AI Code Editing — inline Ctrl+K, diff viewer, apply/reject
5. Codebase Intelligence — indexing, embeddings, vector DB, RAG
6. Agent — tool-calling loop, terminal, git, permission UI
7. Production — auth, RBAC, audit logs, Docker, CI/CD

## Next concrete steps

Tell me which of these to build next and I'll continue in the same way
(real code, run it, verify it, then move on):

- Wire the Model Manager into a real settings UI + `POST /api/v1/models` form
- Build the Composer (multi-file diff/apply) panel
- Build the Agent tool-calling loop + permission-approval UI
- Start the codebase indexer + pgvector-backed RAG
