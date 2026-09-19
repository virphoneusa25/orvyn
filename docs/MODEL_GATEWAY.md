# Model Gateway

Nothing above the gateway names a provider. Agent code resolves models by
role; users and env config decide what actually answers.

```
agent code:            modelGateway.run({ role: "coder", ... })
                                  │
ModelGateway (backend)   role → router task   (coder → executor)
                                  │
ModelRouter (ai-core)    task → model id      (overrides > defaults)
                                  │
ModelRegistry            model id → adapter instance
                                  │
Adapter                  OpenAI-compatible | Ollama | Mock | Pending
```

## Role → task mapping

| Role | Router task |
|---|---|
| orchestrator | planner (verdicts use reviewer) |
| coder, tester, git, browser | executor |
| research | chat |
| security | reviewer |

## Configuration (env)

| Variable | Effect |
|---|---|
| `ASTRA_MODEL_ID` (alias `ORCHESTRATOR_MODEL`) | Registered model id used for planner + reviewer. Astra is a role, not a SKU — there is no "astra-6" model. |
| `DEEPSEEK_API_KEY` | Registers `deepseek-v4-flash` and `deepseek-v4-pro` (OpenAI-compatible wire, `https://api.deepseek.com`) and points `executor` at flash — the coding worker. |
| `MODEL_API_KEY` / `OPENAI_*` | OpenAI or any OpenAI-compatible host. |
| `CHEAPER_INFERENCE_*` | Cheaper Inference catalog (chat/code/image models). |
| `OLLAMA_HOST` / `OLLAMA_MODEL` | Local models; when set, chat/code/agent route here. |
| `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` | Reserved. Adapters exist as typed `PendingProviderAdapter`s that throw "not configured" — Model Manager shows them as Pending. No fake responses. |

Fallback chain when nothing is configured: Mock adapter (explicitly
labeled), so the IDE always boots.

## Runtime management

- `GET/POST/PUT/DELETE /api/v1/models` — registry CRUD from Model Manager.
- `GET/POST /api/v1/routing` — per-task overrides (user > env > default).
- `GET /api/v1/agents` — shows which concrete model each role resolves to
  right now.

## Rules

- Adding a provider = one adapter class in `packages/ai-core/src/adapters`
  implementing `AIModelProvider`. No other file changes.
- API keys live in backend env / registry config. They are never sent to
  the Electron renderer.
- Every model request flows through `ModelGateway.run` — this is the choke
  point where usage metering will attach (see BILLING.md).
