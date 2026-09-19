# Orvyn — commercial readiness

Straight assessment of the gap between "works for me" and "sellable".
Updated 2026-09-14 after the first cloud deployment.

## Done (each verified by test, not assumed)

- **Multi-tenancy.** Per-tenant `ModelService`, `IndexService`, `ToolRegistry`,
  agent sessions, run stores. API keys stored as SHA-256, constant-time
  compared. Cross-tenant leak tests pass (models, index search, WS auth).
- **Real models.** OpenAI-compatible providers, Cheaper Inference, DeepSeek,
  Ollama — routed per task (chat/code/agent/planner/executor/reviewer/vision).
  No mock responses anywhere.
- **Persistence.** Per-tenant SQLite (`node:sqlite`, no native dep): missions,
  usage events, settings, models, accounts, sessions. Survives restarts —
  verified. Cloud tier swaps this for Postgres behind the same calls.
- **Accounts.** Register/login/logout/me with scrypt hashes, 30-day hashed
  session tokens, per-user isolated tenants. Login attempts rate-limited.
- **Usage metering.** Every model call metered at the provider-wrapper choke
  point with mission/task/agent attribution; persisted (billing basis). Token
  counts recorded only when the provider reports them — nothing estimated.
- **Rate limiting.** Token bucket per tenant (`ORVYN_RATE_LIMIT_RPM`,
  default 300/min) and per IP on the open auth routes
  (`ORVYN_AUTH_RATE_LIMIT_RPM`, default 30/min). 429 + `Retry-After` +
  `X-RateLimit-*`. Verified live: 5-limit test returned 200×5 then 429.
- **Quotas.** Monthly model-request quota enforced *before* the provider call
  (`ORVYN_QUOTA_MODEL_REQUESTS_MONTH`), hydrated from persisted usage so a
  restart can't reset a customer's budget. Monthly mission quota
  (`ORVYN_QUOTA_MISSIONS_MONTH`) checked against the persisted missions
  table. Both default to unlimited for local mode. `/usage` reports quota
  state so clients can warn early.
- **Mission concurrency.** Per-tenant FIFO queue
  (`ORVYN_MAX_CONCURRENT_MISSIONS`, default 2). Excess missions wait and
  the run explains why. Unit-tested (bounds, FIFO drain, crash-safe slots).
- **Cloud deployment (single-node).** Live on OVH: Docker Compose (backend +
  Caddy + optional Ollama), healthchecks, log rotation, restart policies,
  persistent data volume. Register/login/usage verified from the public
  internet, and account state survives container rebuilds.

## Still required before you can charge money

### Blocking
1. **Execution sandboxing.** The agent's terminal runs real commands in the
   backend container. Approval-gated and destructive-command-guarded, but a
   paying customer effectively has shell inside the shared container. Needs
   per-tenant Docker workers (the box now exists to build this on). **Do not
   sell multi-tenant access until this is solved.**
2. **Billing.** Usage records and quotas exist; Stripe integration
   (subscriptions, metered overage, webhooks) does not. See docs/BILLING.md.
3. **TLS.** The OVH deployment is HTTP-only until a domain's A record points
   at the server; then set `DOMAIN` in `.env` and restart Caddy (automatic
   Let's Encrypt).

### Serious, not strictly blocking
4. **Organizations/RBAC, email verification, password reset, OAuth.** Solo
   accounts work; teams don't exist yet.
5. **Redis-backed mission queue + worker processes.** The queue interface is
   in (`MissionQueue`); the distributed driver lands with the sandboxing
   work since both need the same worker infrastructure.
6. **Code signing** for the desktop installer (SmartScreen).
7. **Real embeddings** as the default RAG path (semantic, not bag-of-words).
8. **Support surface.** Per-tenant error reporting and log access that
   doesn't require SSHing into prod.

### Legal/commercial (get a lawyer)
- EULA, ToS, privacy policy (customer source code transits the server)
- Dependency license audit
- GDPR/data residency if storing customer code

## Suggested order

1. Docker worker sandboxing on the OVH box (unblocks selling multi-tenant)
2. Stripe billing on the existing usage records + quotas
3. TLS domain, orgs/RBAC, email flows
4. Code signing, real embeddings

## Honest framing

A pragmatic first commercial step remains **self-hosted / single-tenant**:
sell the software, each customer runs their own backend (the Compose stack
deploys in minutes — proven on OVH today). That sidesteps sandboxing and
billing infrastructure while they're built properly.
