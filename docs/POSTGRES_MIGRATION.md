# PostgreSQL Durable-State Migration

## Scope

This branch is **Phase A: mirror + parity validation**.

SQLite remains the synchronous source of truth while ORVYN mirrors durable
writes into PostgreSQL. This keeps the migration reversible and avoids forcing
the entire runtime/auth/storage surface from synchronous APIs to async in one
change.

Enable only with:

```env
ORVYN_POSTGRES_MIRROR=1
DATABASE_URL=postgresql://...
```

Default remains:

```env
ORVYN_POSTGRES_MIRROR=0
```

## What is mirrored

Current durable product state that actually exists in the repository:

- tenant identities
- missions and task JSON
- model usage/billing events
- tenant settings and tool/profile/routing settings
- tenant-added model configurations
- users
- sessions
- legal acceptances

Redis remains responsible for live distributed coordination:

- BullMQ jobs
- live mission state
- controls
- Redis Streams events
- worker heartbeats
- concurrency leases

LiteLLM continues to use its own Redis.

## Backfill

When a tenant is materialized while mirror mode is enabled, ORVYN performs an
idempotent backfill of the complete SQLite tenant state into PostgreSQL.

AuthService also backfills existing users, sessions, and legal acceptances on
startup.

All backfill statements use upserts / conflict-safe inserts so repeated startup
is safe.

## Parity gate

Authenticated endpoint:

```text
GET /api/v1/storage/status
```

Reports:

- PostgreSQL enabled/disabled/ready/unavailable
- schema migration version
- SQLite tenant counts
- PostgreSQL tenant counts
- SQLite auth counts
- PostgreSQL auth counts
- parity booleans

The endpoint returns 503 while mirror mode is enabled and parity is not exact.

## Schema

Migration version 1 contains:

- `schema_migrations`
- `tenants`
- `missions`
- `usage_events`
- `tenant_settings`
- `tenant_models`
- `users`
- `sessions`
- `legal_acceptances`

Projects, organizations/RBAC, subscriptions, credits, and other future product
entities are intentionally not invented here. They should receive first-class
schemas when those product concepts are implemented.

## Phase B cutover requirements

Do not switch reads to PostgreSQL until:

1. PostgreSQL health is stable under the production connection pool.
2. Existing tenants show exact parity after backfill.
3. Auth/session/legal parity is exact.
4. New mission, usage, setting, model, login/logout, and legal writes maintain
   parity during shadow operation.
5. PostgreSQL backup/restore is exercised.
6. Pool exhaustion and database-unavailable behavior is tested.
7. The storage interface is refactored to async reads/writes.
8. Monthly quota/billing counters use atomic PostgreSQL transactions rather
   than read-count-write behavior.
9. A rollback plan keeps SQLite readable until the Postgres primary cutover is
   proven.

Only Phase B should set PostgreSQL as the authoritative application store.
