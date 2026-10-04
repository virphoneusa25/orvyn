# PostgreSQL persistence migration

ORVYN cloud persistence is migrating from per-tenant SQLite files to PostgreSQL
in controlled phases. The migration deliberately does **not** combine a database
cutover with the distributed-runtime cutover.

## Phase A — shadow writes (this branch)

SQLite remains authoritative.

When:

```env
ORVYN_POSTGRES_SHADOW=1
DATABASE_URL=postgresql://...
```

tenant writes are mirrored into PostgreSQL for:

- missions + task graphs
- usage/billing events
- settings and tool overrides
- user-added model configuration

Reads, quota enforcement, Mission Control history, and normal product behavior
continue to use SQLite.

This makes PostgreSQL observable without putting production correctness on a
new database path yet.

The following remain intentionally on SQLite during Phase A:

- accounts/users
- sessions
- legal acceptances
- run event JSONL logs

Auth/session migration will be its own transaction-sensitive phase.

## PostgreSQL tables

Shadow schema:

- `orvyn_missions`
- `orvyn_usage_events`
- `orvyn_settings`
- `orvyn_models`

Every tenant-owned table includes `tenant_id` in its primary key/index design.
One tenant can never overwrite another tenant's mission, setting, usage event,
or model record merely because an object id collides.

## Health

Authenticated runtime health:

```text
GET /api/v1/runtime/status
```

reports storage as either:

```json
{
  "mode": "sqlite",
  "postgres": "disabled"
}
```

or:

```json
{
  "mode": "sqlite-authoritative/postgres-shadow",
  "postgres": "ready",
  "pendingWrites": 0,
  "failures": 0
}
```

If shadow mode is explicitly enabled and PostgreSQL is unavailable, runtime
status reports degraded/503. SQLite remains authoritative, so disabling shadow
mode is the rollback.

## Why shadow writes are non-blocking in Phase A

The current `LocalStore`, `TaskEngine`, and portions of `UsageService` have
synchronous persistence contracts because they were designed around
`node:sqlite`.

Pretending PostgreSQL is synchronous would create hidden fire-and-forget
correctness bugs.

Phase A therefore keeps the synchronous SQLite write as the authoritative
transaction and records PostgreSQL shadow work separately. The shadow store
tracks pending writes/failures and exposes `flush()` for tests/migration tools.

Before PostgreSQL becomes authoritative, the correctness-critical call sites
will be converted to an async persistence contract so durable Postgres writes
are explicitly awaited.

## Cutover phases

### Phase A — SQLite authoritative + PostgreSQL shadow
- private Postgres 16 service
- tenant schema
- shadow writes
- real PostgreSQL CI tests
- runtime health
- no read-path change

### Phase B — backfill + parity
- migrate existing SQLite tenant data
- compare per-tenant row counts
- compare canonical SHA-256 content fingerprints for:
  - missions/task graphs
  - usage/billing events
  - settings/tool overrides
  - model configurations
- deliberately fail parity when same-count rows contain different data
- repair any divergence
- run shadow mode under production traffic

### Phase C — PostgreSQL authoritative
- introduce async persistence interface
- await mission/usage/settings/model writes
- read tenant state from PostgreSQL
- quota/billing queries become transactional PostgreSQL operations
- SQLite becomes local-mode/fallback only

### Phase D — cloud cleanup
- remove shared SQLite volume from cloud workers
- migrate auth/users/sessions/legal acceptance
- add organizations/RBAC/billing tables
- remove transitional shadow code after rollback window

## Rollback

During Phase A:

```env
ORVYN_POSTGRES_SHADOW=0
```

returns ORVYN to the exact SQLite-authoritative behavior.

No Postgres shadow table is allowed to influence model routing, mission
execution, billing enforcement, authentication, or user-visible state during
this phase.


## Backfill command

After building the backend:

```bash
DATABASE_URL=postgresql://... \
ORVYN_DATA_DIR=/data \
npm run postgres:backfill -w @orvyn/backend
```

The command is idempotent. For each tenant it prints SQLite counts, PostgreSQL
counts, content-parity flags, and SHA-256 fingerprints.

A non-matching tenant causes a non-zero exit code. Count equality alone is not
accepted as parity.
