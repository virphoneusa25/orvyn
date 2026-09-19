# Billing & Usage Architecture

Usage **metering is live**; billing (plans, Stripe) is design-only.

## Metering (implemented)

`UsageService` (`apps/backend/src/services/UsageService.ts`) wraps every
provider registered in `ModelService`, so every `generate`, `stream`, and
image call — from chat, composer, inline edit, or any agent — produces a
server-side usage event regardless of which code path made it. Events carry
`{ modelId, provider, method, durationMs, ok, promptTokens?,
completionTokens?, outputChars, toolCalls?, missionId?, taskId?, agent? }`.

Honesty rules enforced in code:

- Token counts are recorded **only when the provider reports them**
  (`AIResponse.usage`). Streaming responses on this wire carry no token
  counts, so those events record duration and output size — never estimates.
- Mission/task/agent attribution flows through `AsyncLocalStorage` context
  set by `MultiAgentRuntime`; requests outside a mission are unattributed.

`GET /api/v1/usage` returns totals (per model, per mission) and recent
events. Events are **persisted** to the per-tenant SQLite store
(`~/.orvyn/data/<tenant>.db`, `usage_events` table) and survive restarts;
the in-memory window holds the most recent 5,000 for fast totals. The cloud
tier swaps SQLite for PostgreSQL behind the same `LocalStore` interface.

## Principles

- **Bill from our own records, not provider dashboards.**
- **Server-side only.** The desktop client never computes or reports
  billable usage; it displays what the server recorded.
- Still to meter: browser runtime, cloud worker runtime, artifact storage.

## Plans (conceptual — pricing not final)

| Plan | Shape |
|---|---|
| FREE | Limited monthly model usage, 1 concurrent mission, local mode only |
| PRO | Higher limits, cloud missions, checkpoints history |
| PRO+ | More cloud runtime, priority workers |
| TEAM | Seats, shared projects, org limits, admin controls |
| ENTERPRISE | SSO, audit logs, custom limits, private deployment |

Plans define: monthly model-usage allowance, cloud runtime minutes,
concurrent missions, storage, team members, advanced agents (browser QA,
security), deployment features. Limits are enforced by the usage service
before job admission, not after the money is spent.

## Stripe integration (when built)

- Products/prices in Stripe; subscription state mirrored to the
  `subscriptions` table via webhooks (`STRIPE_WEBHOOK_SECRET`).
- Metered components reported from usage_events rollups.
- No card data touches ORVYN servers.

## BYO provider keys

Users may bring their own OpenAI/DeepSeek keys (local mode does this
today via env). In cloud mode, BYO keys mean ORVYN meters requests for
quota/limits but does not charge for tokens billed directly to the user's
provider account.
