# Cloud Mode (design — not yet implemented)

Cloud mode lets a mission continue after the user closes their laptop.
None of this tier exists in code today; this document is the committed
design so the local implementation keeps the interfaces cloud-compatible.

```
ORVYN Desktop
   ↓ HTTPS / WebSocket
ORVYN Cloud API  (auth, missions, projects, usage)
   ↓
Job Queue (Redis)
   ↓
Isolated Agent Worker (Docker sandbox per mission)
   ↓ /workspace: repo clone + artifacts + logs + screenshots
Agent team (same MultiAgentRuntime, headless)
   ↓
Tests / Browser QA → Review Engine
   ↓
Artifacts + verdict → WebSocket → Desktop
```

## Design rules already being honored locally

- **One agent implementation.** `MultiAgentRuntime`, `TaskEngine`,
  `EventBus`, `ToolGateway`, and `ModelGateway` have no Express or
  Electron dependency — the cloud worker imports them unchanged and runs
  them against a cloned repo instead of a local folder.
- **Event log is transport-agnostic.** The ordered, replayable
  `sequence`-numbered run log works identically over SSE (today) and a
  cloud WebSocket fanout (later).
- **Tenancy exists.** `TenantManager` already isolates per-tenant service
  graphs; cloud adds real users/orgs on top.

## What must be built (in order)

1. Persistence: mission/task/usage/checkpoint repositories (SQLite local,
   PostgreSQL cloud — same interface).
2. `apps/cloud` API service: auth (sessions + refresh tokens, orgs,
   memberships), project/mission CRUD, WebSocket event fanout.
3. Redis job queue; worker process consuming mission jobs.
4. Docker worker image: clone repo → run mission headless → upload
   artifacts (object storage: screenshots, logs, reports — not in
   PostgreSQL).
5. Resource limits per worker: CPU, memory, disk, network, wall-clock.
6. Usage metering + billing (see BILLING.md).

## Hard security requirements

- Customer code never executes in the API server process — workers only.
- Workers are per-mission, isolated, resource-limited, and torn down.
- Tenant isolation enforced at API and database layers; no cross-org
  access paths.
- Kubernetes/VM workers may replace Docker later — the worker contract
  (queue message in, events + artifacts out) must not change.
