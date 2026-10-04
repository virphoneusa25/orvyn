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

This infrastructure phase **does not yet move missions to BullMQ**.

The existing in-process `MissionQueue` remains active. The backend receives
`ORVYN_REDIS_URL` and `MODEL_ROUTER_URL` now so the next phases can replace
the queue and provider transport without changing the container contract again.

The backend temporarily retains the Docker socket mount. It will move to the
dedicated worker service when BullMQ workers are introduced.

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

### Remaining cutover work

Before setting the feature flags to `1`:

1. Move approval/steer/cancel commands to the Redis control stream.
2. Project worker-emitted Redis Stream events into the API `RunStore`.
3. Re-host the existing `MultiAgentRuntime` in the worker harness.
4. Ensure worker and API share durable mission/task state.
5. Move the Docker socket off the API container.
6. Shadow-run the distributed path and compare event parity.
7. Only then switch `/agent/orchestrate` to BullMQ.
