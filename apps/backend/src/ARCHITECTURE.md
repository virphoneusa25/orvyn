# ORVYN backend architecture (migration report)

ORVYN is an AI engineering operating system with an IDE attached. Astra
(orchestrator/reviewer role) plans and judges; worker agents implement through
one Tool Gateway; models stay replaceable behind the Model Gateway.

## Reused as-is (do not replace)

| Piece | Where |
|---|---|
| Model routing (`planner`/`executor`/`reviewer`/…) | `packages/ai-core/src/router.ts`, `services/ModelService.ts` |
| OpenAI-compatible / Ollama / mock adapters | `packages/ai-core/src/adapters/` |
| Tool registry + `allowed\|ask\|denied` | `ai/ToolTypes.ts` |
| Single-agent streaming loop | `agent/StreamingAgentRuntime.ts` |
| Plan → execute → review loop | `agent/MultiAgentRuntime.ts` |
| Event log + SSE reconnect | `agent/events.ts` (RunStore) |
| Mode permission profiles | `agent/modes.ts` |
| RAG index (seed of Context Engine) | `indexing/IndexService.ts` |
| Electron security (contextIsolation, sandbox, no Node in renderer) | `apps/desktop/src/main/main.ts` |

## New modules (this migration)

| Module | Role |
|---|---|
| `gateway/PermissionEngine.ts` | Capability flags (READ/WRITE/DELETE/EXECUTE/NETWORK/GIT/…) mapped onto tool names; agents cannot bypass |
| `gateway/ToolGateway.ts` | Sole tool registration/execution path |
| `gateway/ModelGateway.ts` | Role → provider resolution; `ORCHESTRATOR_MODEL` env picks the Astra model; no vendor `if`s in agent code |
| `agent/Agent.ts` | Shared Agent interface (id, role, modelTask, tools, permissions, state, execute) |
| `agent/TaskEngine.ts` | Mission + task state machine (QUEUED…BLOCKED) |
| `agent/EventBus.ts` | Mission/agent/test/review/checkpoint events over RunStore |
| `review/ReviewEngine.ts` | Mandatory final review: `{status, score, blockingIssues, warnings, requiredChanges}`; max 3 cycles then BLOCKED |
| `checkpoint/CheckpointEngine.ts` | Snapshot/restore/compare under `.orvyn/checkpoints/` |
| `context/ContextEngine.ts` | Targeted per-task context (ripgrep + symbols + index); never the whole repo |
| `mcp/McpHub.ts` | MCP servers from `.orvyn/mcp.json`, exposed only as gateway tools |
| `agent/contextBudget.ts` | Context-window budgeting: head/tail clamps on tool output + history compaction that never orphans a `tool` message (that would 400 the next request) |
| `agent/editPreview.ts` | Read-only pre-computation of what a file tool would change, so approvals show a real diff instead of raw JSON |
| `sandbox/DockerSandbox.ts` | Per-mission isolated execution (cloud): sibling container, no network, caps dropped, resource ceilings, per-command timeouts, merge-back to the project tree. Enabled with `ORVYN_MISSION_EXECUTION=sandbox` |

## Conflicts resolved

- `search_code`, `edit_file`, `delete_file`, `move_file` existed but were never
  registered → now registered through the Tool Gateway.
- `terminal` keeps its name; `run_command` is an alias of the same tool.
- `list_symbols` is the v1 `search_symbols`; `find_references` stays a pending
  Context Engine method until LSP lands.
- Right-pane Chat/Composer/Agent becomes Chat/Plan/Build/Review: Composer is the
  Plan tab implementation; Agent+Multitask become Build.

## Model identity

- **Astra is a role, not a SKU.** `ORCHESTRATOR_MODEL` (env/settings) maps to the
  `planner` + `reviewer` router tasks. No `astra-6` anywhere.
- **Coding worker** defaults to `deepseek-v4-flash` when `DEEPSEEK_API_KEY` is
  set (OpenAI-compatible wire, endpoint `https://api.deepseek.com`); otherwise
  the existing Cheaper Inference / OpenAI / Ollama / mock chain.
- Anthropic/Google: typed pending adapters — visible in Model Manager as
  "Pending — add API key", never silently faked.

## Ground rules

- No placeholder buttons; unfinished features surface as disabled Pending UI.
- Workers never talk to each other; results return to Astra via the Task Engine.
- Dangerous tools stay `ask` unless the user turns on Autonomous mode.
- Never auto-push to remotes.
