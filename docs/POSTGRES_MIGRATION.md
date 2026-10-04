# PostgreSQL Durable-State Migration

## Scope

This branch contains **Phase A mirror/parity validation and the feature-gated Phase B cutover**.

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
8. Monthly mission/model admission uses PostgreSQL reservations in primary-write mode;
   credits/billing settlement still requires its own atomic ledger.
9. A rollback plan keeps SQLite readable until the Postgres primary cutover is
   proven.

Only Phase B should set PostgreSQL as the authoritative application store.


## Phase B staged primary reads/writes

The stacked Phase B branch adds three independent flags:

```env
ORVYN_POSTGRES_PRIMARY_READS=0
ORVYN_POSTGRES_PRIMARY_WRITES=0
ORVYN_POSTGRES_READ_FALLBACK_SQLITE=1
```

### Primary reads

When enabled, PostgreSQL supplies:

- session verification
- login credential lookup
- legal acceptance lookup
- tenant model configuration bootstrap
- tenant routing/profile settings bootstrap
- Mission Control mission/task reads
- monthly mission quota counts
- monthly model-request quota counts
- usage/reporting totals
- recent usage events

A fresh API node can authenticate an existing user and reconstruct their tenant
model/routing/profile configuration from PostgreSQL even when its local SQLite
cache starts empty.

### Primary mission writes

When `ORVYN_POSTGRES_PRIMARY_WRITES=1`, `MultiAgentRuntime` uses TaskEngine
durable mutation wrappers. Mission creation, status transitions, task creation,
task transitions, and review-cycle changes wait for the PostgreSQL mirror write
chain to acknowledge before ORION advances to the next state.

SQLite is still updated as the node-local compatibility cache.

A PostgreSQL write failure is surfaced through `flushStrict()` instead of
being silently logged and ignored.

### Usage durability

Model generate/stream/image paths use an async usage recording boundary when
primary writes are enabled. A completed provider call waits until its usage
event is visible in PostgreSQL before the next PostgreSQL-backed quota decision.

This closes the short race where back-to-back model calls could both pass a
quota check before the first usage event reached the primary store.

### Storage status

`GET /api/v1/storage/status` reports the active staged mode:

- `sqlite-primary`
- `sqlite-primary-postgres-mirror`
- `postgres-primary-reads`
- `postgres-primary-reads-acknowledged-mission-writes`

along with PostgreSQL health, schema version, and parity counts.

### Still not cut over

This branch does not yet remove SQLite from the cloud deployment. SQLite remains
the local cache/fallback and the synchronous compatibility layer.

Full primary-store conversion still requires:

- atomic billing/credits/subscription accounting
- first-class organization/project schemas
- production backup/restore and off-host recovery drills
- explicit DB outage/failover testing
- final removal of cloud SQLite authority/cache dependencies


## Backup / restore cutover gate

CI now performs a real PostgreSQL 16 disaster-recovery drill:

1. `pg_dump -Fc` the live integration database.
2. Create a second empty database.
3. Restore with `pg_restore`.
4. Compare row counts for every current durable table:
   - schema_migrations
   - tenants
   - missions
   - usage_events
   - usage_reservations
   - mission_reservations
   - tenant_settings
   - tenant_models
   - users
   - sessions
   - legal_acceptances

The PostgreSQL cutover is not considered ready if backup/restore parity fails.

Production should use the same principle with encrypted off-host backups,
retention policies, and a scheduled restore drill. A backup that has never been
restored successfully should not be treated as a recovery plan.


## Tenant model credential encryption

Cloud/PostgreSQL persistence requires a stable 32-byte secret:

```env
ORVYN_MODEL_SECRET_KEY=<64 hex chars or base64-encoded 32 bytes>
```

Recommended generation:

```bash
openssl rand -hex 32
```

When configured:

- tenant-added model API keys are encrypted with AES-256-GCM before being
  written to PostgreSQL
- the same protection is applied to the node-local SQLite compatibility cache
- each stored value uses a fresh random 12-byte IV and authenticated GCM tag
- runtime loaders decrypt only in memory
- existing plaintext migration rows remain readable so they can be rewritten
  during normal backfill/save operations

The key must be identical across API and worker instances and should be stored
only in the deployment secret manager. Losing it makes encrypted tenant model
credentials unrecoverable.

## Transactional account writes

When both staged primary flags are enabled:

```env
ORVYN_POSTGRES_PRIMARY_READS=1
ORVYN_POSTGRES_PRIMARY_WRITES=1
```

new account registration is committed in one PostgreSQL transaction containing:

- user
- legal acceptance
- initial session

PostgreSQL therefore becomes the global uniqueness boundary for account email
addresses across multiple API nodes.

Login session creation, logout, and legal acceptance writes are also
PostgreSQL-acknowledged before the local SQLite cache is updated.

`PRIMARY_WRITES` cannot activate unless `PRIMARY_READS` is also enabled.


## Atomic quota admission (migration version 2)

With primary reads **and** primary writes enabled, monthly model-request and
mission quotas reserve capacity in PostgreSQL before provider execution or
mission queue admission. A per-tenant, per-quota transaction lock serializes
the count of completed records plus outstanding reservations with insertion of
the next reservation. Requests rejected at this boundary do not invoke providers
or start missions. Admission never falls back to SQLite during a database outage.
Read-only canaries still use their configured SQLite read fallback.

Version 2 adds `usage_reservations` and `mission_reservations`. Completing a
usage event or persisting a mission replaces its matching reservation atomically
in the same SQL statement. Event IDs remain stable across settlement retries;
mission reservations use the run ID, including while BullMQ jobs wait in queue.
Mission creation retains its admission timestamp so a queue delay across the UTC
monthly boundary cannot move consumption to the wrong month.

Provider failures count as attempts. Streams closed early settle one failed
usage event. If a process crashes or settlement/enqueue acknowledgement is
uncertain, its reservation remains counted until the UTC monthly reset; there is
no automatic expiry that could admit additional paid work. Operators must verify
that no work executed before manually releasing an abandoned reservation.
Outstanding reservations are quota state, not completed usage or billing events,
and are included in database backups. This does not implement a credits ledger.

Database connections have a five-second acquisition deadline. SQL statements
have a ten-second deadline and lock waits have a five-second deadline, so a stuck
pool or lock cannot indefinitely block the provider admission/write chain.
CI exercises competing independent PostgreSQL connections, quota saturation,
stream closure, settlement retry, pool exhaustion, unavailable connections and
recovery. A real production failover drill remains required before broad rollout.
