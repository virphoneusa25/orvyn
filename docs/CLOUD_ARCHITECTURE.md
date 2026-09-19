# ORVYN Cloud Architecture (design — not yet implemented)

Target architecture for the SaaS tier. See CLOUD_MODE.md for the user-facing
flow; this document covers services, data, and scaling. Nothing here is in
code yet except what is explicitly marked existing.

## Services

```
                    ┌─────────────┐
 Desktop ──HTTPS──▶ │  API server │──┐   (stateless; N instances behind LB)
          ◀──WS───  └─────────────┘  │
                          │          │
        ┌─────────────────┼──────────┼──────────────┐
        ▼                 ▼          ▼              ▼
   PostgreSQL          Redis     Object storage   Model providers
   (state)          (queue,     (artifacts)      (external APIs)
                     fanout,
                     locks)
                          │
                          ▼
                   ┌─────────────┐
                   │   Workers   │  (Docker sandbox per mission)
                   └─────────────┘
```

| Service | Responsibility | Exists today? |
|---|---|---|
| API | Auth, projects, missions, usage, WebSocket fanout | Partially — the local backend's REST/SSE API is the contract seed |
| Worker | Consume mission jobs, run agent runtime headless in a sandbox | No — but the runtime it wraps exists and is Express-free |
| Auth service | Sessions, refresh tokens, OAuth, orgs, memberships | No |
| Usage service | Usage events per model request / tool call / runtime | No — choke point (`ModelGateway.run`) exists |
| Billing service | Stripe subscriptions on top of usage records | No |

## PostgreSQL schema (planned)

users, organizations, memberships, subscriptions, projects, repositories,
branches, environments, missions, tasks, agents, agent_runs, tool_calls,
checkpoints, artifacts, reviews, usage_events, model_requests, api_keys,
integrations, mcp_servers.

Rules: migrations from day one; no plaintext secrets (hash API keys,
encrypt provider credentials at rest); every row carries org ownership and
queries are tenant-scoped at the repository layer.

## Redis

Job queue (mission jobs), worker heartbeats, event fanout to WebSocket
nodes, rate limiting, distributed locks (one active worker per mission).

> **Status:** the queue *interface* is implemented and in production use —
> `apps/backend/src/queue/MissionQueue.ts`, an in-process FIFO driver that
> bounds per-tenant mission concurrency (`ORVYN_MAX_CONCURRENT_MISSIONS`).
> `POST /agent/orchestrate` already goes through it. The Redis driver
> replaces that class behind the same `enqueue()` call when the worker tier
> is built; it deliberately does not exist yet because there is nothing to
> distribute to until per-mission worker containers land. Rate limiting and
> quotas are also live (in-process, per node): `middleware/rateLimit.ts`,
> `UsageService.checkQuota()` — the Redis versions become necessary only
> with multiple API nodes.

## Workers

- One Docker container per mission: `/workspace/{repo,artifacts,logs,screenshots}`
- Limits: CPU, memory, disk quota, egress policy, wall-clock timeout
- Contract: consume job message → emit run events (same schema as local
  `RunStore`) → upload artifacts → report terminal status
- Interface designed so Docker can be swapped for Kubernetes jobs or
  microVMs without touching the agent runtime

## Scaling path

1. Single VM: API + worker + Postgres + Redis via docker-compose
   (OVH_DEPLOYMENT.md starts here)
2. Split workers onto separate hosts; managed Postgres/Redis
3. Load balancer + N stateless API nodes; Redis pub/sub carries events to
   whichever node holds the client's socket
4. Object storage (S3-compatible, e.g. OVH Object Storage) for artifacts

## Cost controls (mission-level, enforced by the worker)

max model requests, max tokens, max runtime, max tool calls, max retries,
max review cycles (3 — already enforced locally). Organization-level
quotas layer on top in the usage service.
