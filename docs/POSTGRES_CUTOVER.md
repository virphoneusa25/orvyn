# PostgreSQL production cutover runbook

This runbook moves ORVYN tenant data from SQLite authority to PostgreSQL
authority. It does **not** migrate auth/users/sessions/legal acceptance; those
remain on `auth.db` during this phase.

## Preconditions

Do not start this procedure unless:

- PR #2 distributed runtime is deployed and stable.
- PostgreSQL shadow mode has run under representative traffic.
- PostgreSQL persistence CI is green.
- A current backup/snapshot exists for the SQLite data volume.
- `ORVYN_POSTGRES_SHADOW=1` can be disabled during the cutover window.

## 1. Keep SQLite authoritative

Production starts from:

```env
ORVYN_PERSISTENCE_DRIVER=sqlite
ORVYN_POSTGRES_SHADOW=1
ORVYN_POSTGRES_CUTOVER_CONFIRMED=0
```

Confirm:

```text
GET /api/v1/runtime/status
```

reports:

```text
sqlite-authoritative/postgres-shadow
postgres: ready
failures: 0
```

Do not proceed with pending/failing shadow writes.

## 2. Stop tenant-data mutations for the final sync

Drain/stop new cloud missions and pause settings/model/profile changes for the
short cutover window.

Workers should finish their active missions before the final parity check.

## 3. Run idempotent backfill

Inside the backend build/runtime environment:

```bash
DATABASE_URL="$DATABASE_URL" \
ORVYN_DATA_DIR=/data \
npm run postgres:backfill -w @orvyn/backend
```

Every tenant must report:

```json
{"matches":true}
```

## 4. Run the read-only parity gate

Immediately after backfill:

```bash
DATABASE_URL="$DATABASE_URL" \
ORVYN_DATA_DIR=/data \
npm run postgres:verify -w @orvyn/backend
```

This command does not write PostgreSQL.

For every tenant it compares:

- mission/task row count + SHA-256 content fingerprint
- usage row count + SHA-256 content fingerprint
- settings row count + SHA-256 content fingerprint
- model config row count + SHA-256 content fingerprint

**Do not cut over if any `matches:false` is reported.**

## 5. Flip authority

Set:

```env
ORVYN_PERSISTENCE_DRIVER=postgres
ORVYN_POSTGRES_SHADOW=0
ORVYN_POSTGRES_CUTOVER_CONFIRMED=1
```

Deploy/restart API and workers.

ORVYN intentionally refuses to initialize PostgreSQL-primary mode when:

- `ORVYN_POSTGRES_CUTOVER_CONFIRMED != 1`
- `DATABASE_URL` is missing
- shadow mode is still enabled

## 6. Verify runtime

Check:

```text
GET /api/v1/runtime/status
```

Expected storage section:

```json
{
  "mode": "postgres-authoritative",
  "primary": "postgres",
  "postgres": "ready",
  "shadow": "disabled"
}
```

Then verify:

- existing Mission Control history loads
- custom model configs load
- routing/profile/tool overrides survive restart
- Reports show existing usage
- monthly quota used count is preserved
- a new mission persists tasks/status through restart
- distributed worker missions appear in Mission Control
- model calls record new usage events

## 7. Quota correctness

In PostgreSQL-primary mode, model-request quota slots are reserved atomically
inside PostgreSQL before paid inference begins.

This prevents concurrent workers from overspending the last plan slot.

A provider failure still consumes the reserved request, matching ORVYN's
existing request-counting semantics.

## Rollback

If PostgreSQL-primary shows a correctness problem before new PostgreSQL-only
writes have materially diverged:

1. stop API/workers
2. restore:
   ```env
   ORVYN_PERSISTENCE_DRIVER=sqlite
   ORVYN_POSTGRES_SHADOW=0
   ORVYN_POSTGRES_CUTOVER_CONFIRMED=0
   ```
3. restart ORVYN
4. investigate the PostgreSQL divergence

Once PostgreSQL-primary has accepted meaningful new tenant mutations, do **not**
blindly roll back to the older SQLite copy. Export/reconcile those writes first.

## After the rollback window

Only after PostgreSQL-primary has proven stable:

- remove shared tenant SQLite files from cloud workers
- keep SQLite adapter for desktop/local mode
- migrate auth/users/sessions/legal acceptance to PostgreSQL
- add organization/RBAC/billing-credit tables
- remove Postgres shadow migration code
