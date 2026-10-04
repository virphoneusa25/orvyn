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
