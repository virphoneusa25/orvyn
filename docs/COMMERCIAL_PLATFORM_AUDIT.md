# ORVYN Commercial Platform Audit

> Status: 2026-09-19. Assessed against the "ORVYN COMMERCIAL CLOUD PLATFORM"
> master spec. Every "exists" claim below was verified against code or a
> live deployment, not documentation.

## What already exists (verified)

| Capability | Where | Notes |
|---|---|---|
| Auth: register/login/sessions/API keys | `auth/AuthService.ts`, per-tenant API keys | scrypt hashing, timing-safe compare |
| Per-tenant isolation (single-tenant default) | `tenancy/TenantManager.ts` | Every resource scoped to a tenant |
| Rate limiting | `middleware/rateLimit.ts` | Per-IP and per-tenant |
| Usage metering (server-side, per request) | `services/UsageService.ts` | Every model call wrapped; monthly quota persisted across restarts |
| Runaway-guard budgets | run + mission caps | Active on local and OVH (60 req / 2M tok / 200 tools per run) |
| Retry/backoff at the provider boundary | `services/modelRetries.ts` | Transient-only, abort-aware |
| Provider-independent model gateway | `packages/ai-core` | Router + capability validation; OpenAI-compatible/Ollama/mock live |
| Mission/task engine + review loop | `agent/*` | Plan → workers → mandatory review, 3 cycles → BLOCKED |
| Tool Gateway + capability permissions | `gateway/*` | Sole execution path, per-role capabilities |
| **Docker sandbox execution (cloud)** | `sandbox/DockerSandbox.ts` | Live on OVH: per-mission container, `--network none`, `--cap-drop ALL`, CPU/mem/pid ceilings, per-command + wall-clock timeouts, merge-back, verified end-to-end 2026-09-19 |
| Checkpoints + Undo | `checkpoint/CheckpointEngine.ts` | Pre-run snapshots, restore removes run-created files |
| SSH remote admin tool | `ai/tools/sshTools.ts` | Host allowlist, key-auth, always-ask |
| OVH deployment | `infrastructure/ovh/` | Caddy TLS-ready (needs DOMAIN + DNS), healthchecks, log rotation, backups |

## Gaps against the commercial spec (the honest list)

1. **PostgreSQL schema + migrations** (spec Part 4). Today: SQLite per tenant.
   Fine for single-tenant; not the multi-tenant SaaS substrate.
2. **Credit wallet + immutable ledger** (Parts 10–13). Not started. Design
   constraint already honored: server-side metering exists, so the ledger has
   a real feed — the desktop is not the billing authority today and must stay
   that way.
3. **Stripe billing** (Part 15). Not started (keys already reserved in
   `.env.example`).
4. **Organizations/teams, plan entitlements** (Parts 8–9). Not started.
5. **Email verification / password reset** (Parts 6–7). Auth exists; these
   flows need SMTP + token tables.
6. **Admin console + profitability reporting** (Parts 40–42). Usage totals
   exist (`/usage`, Reports panel); no revenue/margin views (no billing yet).
7. **Redis job queue** (Part 30). `MissionQueue` is in-process. The
   `DockerSandbox` interface was written so a worker process behind a real
   queue can adopt it unchanged.

## Phased plan (each phase ships tested and deployed)

- **Phase A — data substrate:** PostgreSQL + migrations (users, orgs,
  wallets, ledger, usage_events), dual-write from SQLite during transition.
- **Phase B — identity:** email verification, password reset, refresh-token
  rotation, organizations + roles.
- **Phase C — plans & entitlements:** DB-driven plans, entitlement service
  (`canUseFeature`), model-access policy per plan.
- **Phase D — credits:** integer-only wallet, immutable ledger, buckets with
  expiry priority, reserve/settle flow, concurrency-safe deductions.
- **Phase E — Stripe:** checkout, webhooks (idempotent), credit packs,
  subscriptions, billing portal.
- **Phase F — admin + margins:** provider cost vs customer charge separation,
  rate-card history, profitability dashboard.
- **Phase G — scale-out:** Redis queue, worker pool consuming sandbox jobs,
  multiple API replicas.

## Order rationale

The expensive money-correctness work (Phase D) lands only after the data
substrate and identity exist, and Stripe (E) only after the ledger — adding
payments before the ledger exists is how billing systems become unfixable.
The sandbox (done) is deliberately first: it is the piece that makes every
later phase safe to run against real customers.

## Invariants to hold through every phase (spec Part 53)

Credits move only via ledger transactions; one request settles exactly once;
provider cost and customer charge never conflate; the desktop never reports
its own usage or balance; admin mutations are audited.
