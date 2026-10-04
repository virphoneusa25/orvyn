# ORVYN Redis Split

ORVYN now reserves two independent Redis services in production Compose.

## orvyn-redis

Purpose:

- BullMQ mission queue (next migration phase)
- durable distributed mission coordination
- Redis Streams mission/event transport
- stop/steer/approval coordination across API and worker processes

Safety:

- AOF persistence enabled
- `appendfsync everysec`
- `maxmemory-policy noeviction`
- internal Compose network only
- independent password and volume

## litellm-redis

Purpose:

- LiteLLM router coordination
- provider cooldown state
- retry/routing metadata
- optional future response/cache metadata

It is intentionally separate from the BullMQ Redis so model-router behavior
cannot evict or interfere with mission queue/event state.

## Current migration status

The distributed runtime path is implemented behind feature flags and remains
OFF by default.

When both distributed flags are enabled, cloud workspaces beneath
`ORVYN_DISTRIBUTED_PROJECT_ROOT` are dispatched through BullMQ and executed
by the dedicated worker service using the existing `MultiAgentRuntime`.
Desktop/local project roots remain on the existing local execution path.

Implemented distributed pieces:

- BullMQ mission dispatch
- Redis Streams worker → API events
- Redis Streams approve/deny/steer/cancel controls
- API-authoritative SSE sequencing
- idempotent event replay after API restart
- durable Redis event cursors
- worker-side re-hosting of the existing `MultiAgentRuntime`
- crash-safe per-tenant mission concurrency leases
- shared cloud-workspace eligibility guard
- feature-gated LiteLLM model tiers beneath `ModelGateway`

The backend still temporarily retains the Docker socket because the local
fallback path remains available. Removing that mount is a final deployment
cutover step after distributed cloud execution is enabled in production.

## Required secrets

- `ORVYN_REDIS_PASSWORD`
- `LITELLM_REDIS_PASSWORD`
- `LITELLM_MASTER_KEY`
- `LITELLM_SALT_KEY`

Existing provider keys remain unchanged.

## Validation

After creating `.env`:

```bash
docker compose config
docker compose up -d orvyn-redis litellm-redis litellm
docker compose ps
docker compose exec orvyn-redis redis-cli -a "$ORVYN_REDIS_PASSWORD" ping
docker compose exec litellm-redis redis-cli -a "$LITELLM_REDIS_PASSWORD" ping
```

Both Redis commands must return `PONG`.


## Phase 2 scaffold: BullMQ + Redis Streams

The branch now also contains the distributed runtime substrate:

- `apps/backend/src/queue/types.ts`
  - serializable `MissionJobPayload`
  - queue/stream naming contracts
- `apps/backend/src/queue/redisConnection.ts`
  - request-path producer connection policy
  - durable worker connection policy
- `apps/backend/src/queue/RedisMissionQueue.ts`
  - BullMQ queue transport
  - idempotent job ids based on `runId`
- `apps/backend/src/queue/RedisRunEventTransport.ts`
  - Redis Streams publish/replay transport
  - capped approximate stream length to bound event storage
- `apps/backend/src/workers/missionWorker.ts`
  - scalable worker process entry point

### Safety gate

Distributed execution is intentionally fail-closed until the control plane is
also distributed. Two flags must eventually be enabled together:

```
ORVYN_DISTRIBUTED_MISSIONS=1
ORVYN_DISTRIBUTED_CONTROLS=1
```

Today both default to `0`.

This prevents a worker from running a mission while approvals, steering, or
cancellation still live only in the API process memory.

### Compose worker profile

The worker is opt-in:

```bash
docker compose --profile distributed up -d
```

Later, after the control channel cutover:

```bash
docker compose --profile distributed up -d --scale orvyn-worker=5
```

No worker has a fixed `container_name`, so Compose can scale it horizontally.

### Remaining production cutover work

Before enabling the feature flags on the live cloud deployment:

1. Deploy both Redis services and LiteLLM with production secrets.
2. Start one worker first and run shadow/smoke missions under `/projects`.
3. Verify approval, steer, cancel, restart recovery, sandbox cleanup, and event
   parity against the current in-process path.
4. Observe SQLite write contention under the real workload; keep worker scale
   conservative until the planned PostgreSQL migration is complete.
5. Enable distributed cloud missions gradually.
6. Remove the Docker socket from the public API container once no cloud mission
   still depends on API-owned sandbox execution.
7. Migrate durable SaaS state from SQLite to PostgreSQL as a separate change.


## Distributed control and API event bridge

The transport layer now includes:

- `RedisRunControlTransport`
  - approve/deny
  - allow-once / allow-for-mission scope
  - steer
  - cancel
- `RunControlPublisher`
  - API-facing command publisher
  - authorization remains at the existing HTTP boundary
- `RedisRunEventBridge`
  - consumes worker event envelopes
  - forwards them into the existing `RunStore`
  - preserves current SSE/UI behavior
  - API `RunStore` remains the canonical event sequence allocator

### Why worker events do not carry SSE sequence numbers

The API and worker are separate processes. If both generated
`AgentEvent.sequence` independently, reconnect cursors could collide.

Workers therefore publish:

```text
runId
type
timestamp
data
```

The API bridge then calls the existing `RunStore.emit()`, which assigns the
single canonical sequence used by Desktop/Web/Mobile SSE clients.

### PostgreSQL

PostgreSQL is intentionally not added in this infrastructure PR. ORVYN's
existing SQLite persistence remains the production state store until
distributed execution parity is verified. Persistence migration will be a
separate phase so execution-topology defects are not mixed with database
migration defects.


## LiteLLM model routing cutover

ORVYN now supports LiteLLM as an operational routing layer beneath the existing
`ModelGateway`.

Enable with:

```env
ORVYN_LITELLM_ENABLED=1
MODEL_ROUTER_URL=http://litellm:4000
MODEL_ROUTER_KEY=<same value as LITELLM_MASTER_KEY>
```

The URL is the LiteLLM server root, **not** `/v1`, because ORVYN's
OpenAI-compatible adapter appends `/v1/chat/completions`, `/v1/models`,
and other wire endpoints itself.

When enabled, default semantic routes become:

- chat / completion → `litellm:fast-tier`
- code / agent / executor → `litellm:code-tier`
- planner / reviewer → `litellm:premium-tier`

Vision, image generation, and embeddings remain on their existing routes until
dedicated LiteLLM groups are defined.

Direct providers remain registered and available for manual routing/rollback.


## Distributed workspace boundary

Workers only accept mission project roots underneath:

```env
ORVYN_DISTRIBUTED_PROJECT_ROOT=/projects
```

This prevents a cloud backend from accepting a desktop-local path such as
`C:\\Users\\...\project` or `/Users/.../project` that the worker cannot see.
Local desktop projects continue using the existing local runtime.

## Distributed tenant concurrency

`ORVYN_MAX_CONCURRENT_MISSIONS` remains a per-tenant limit in distributed
mode. Workers acquire renewable Redis leases before executing a mission. If a
tenant has filled its slots, BullMQ moves the job back to the delayed set
instead of consuming an idle worker while waiting. Leases expire automatically
after a worker crash and are renewed while a mission remains active.


## Runtime readiness

Authenticated clients/operators can inspect:

```text
GET /api/v1/runtime/status
```

The response reports:

- distributed runtime enabled/disabled
- active BullMQ worker count
- BullMQ waiting/active/completed/failed/delayed counts
- `orvyn-redis` availability
- LiteLLM liveness when `ORVYN_LITELLM_ENABLED=1`

When distributed mode is enabled but no worker heartbeat is alive, the endpoint
returns a degraded/503 status instead of claiming the execution plane is ready.

## Stalled mission policy

BullMQ normally follows an at-least-once model for stalled jobs and may
re-process a mission after a worker loses its lock. ORVYN autonomous missions
may contain non-idempotent file, terminal, server, or deploy actions, so the
default is:

```env
ORVYN_WORKER_MAX_STALLED_COUNT=0
```

That causes a stalled autonomous mission to fail rather than silently replay
partially completed tool work. Raise the value only after mission-level
idempotency/recovery semantics are explicitly implemented and tested.

## Queued cancellation

Stopping a distributed run before it starts removes the pending/delayed BullMQ
job immediately, writes `cancelled` to live Redis mission state, and emits the
normal `run.cancelled` event. Active jobs continue to use the Redis control
stream so the owning `MultiAgentRuntime` handles cancellation safely.
