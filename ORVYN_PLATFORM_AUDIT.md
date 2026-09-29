# ORVYN platform architecture audit (SaaS build, phase 0)

Date: 2026-09-29.
Baseline commit: `c63313c` on the laptop (`dd21109` in the cloud clone). Both have tree `cca6a42d`.

This is an internal engineering document. Customer-facing surfaces never name the hosting provider, its servers, or model providers.

## 1. Where things stand

| Area | State today | Verdict |
|---|---|---|
| Signup / login | scrypt passwords, `users`/`sessions` in SQLite `auth.db`. The lockout counter is in memory. | Keep; move to Postgres (phase 1b) |
| Email verification | Hashed single-use tokens with a 24 h expiry. Required only when mail is configured. | Keep |
| Account gate | **New (c63313c).** Desktop: no Skip, no anonymous local mode, sign-out returns to the gate. Server: `requireAccountReady` returns 403 until the email is verified and onboarding is finished; the chat socket is gated too. | Done |
| Password reset | Missing | Phase 1 |
| Google / GitHub login | **Missing, but the buttons exist.** Desktop calls `/auth/oauth/*`, which returns 404. | Phase 1 (P0) |
| Refresh rotation, logout-all, device sessions | Missing. 30-day opaque tokens. Tokens are accepted in `?token=`. | Phase 1 |
| Desktop auth (system browser + PKCE, single-use code) | Missing. Desktop posts the password directly. | Phase 1 |
| Organizations | Kinds are personal/company. Roles are owner/admin/member (no viewer). Members are added by raw user id with no invite. Roles are not enforced on billing, model or routing routes. | Phase 1 |
| Postgres | Migrates the `identity_*` tables, but **nothing reads them**. All state is SQLite under `/data`. | Phase 1b decision (below) |
| Redis | Health PING only | OK (queues/cache only, as specified) |
| Plans | `plans.ts`: Free/Starter/Pro/Power/Business/Team/Enterprise with rolling 5 h/7 d windows. Hardcoded and unversioned. The project/agent limits are not enforced. | Phase 2 (versioned) |
| Ledger | `billing.sqlite`. **Balances are mutable columns.** Rows are a log, not the source of truth. No DB transactions, no idempotency keys. `setPlan` re-grants credits. Reservations exist but are unused. | Phase 2 (rebuild as an append-only ledger) |
| **Plan / top-up endpoints** | **`POST /billing/plan` and `POST /billing/topup` grant paid plans and credits with no payment.** | **P0: closed first** |
| Stripe | None. `NullBillingProvider`. The desktop calls `/billing/checkout`, which returns 404. | Phase 2 |
| Usage metering | Charged after the call. Limit errors are swallowed. Streams without token counts are free. One flat rate card ($0.20/$0.80 per M tokens) for every model. | Phase 2 / 6 |
| Model names | Raw provider ids (`fw:accounts/...`) are exposed by `GET /models`. Tenants can edit the routing. | Phase 6 (AUTO/Fast/Reasoning/Code/Research/Vision) |
| Failover | Same model across providers (`sameModelElsewhere`). Failed calls are billed at 0. | Keep; add per-request idempotency |
| Admin console | None: no staff roles, no audit log, no suspension, no "view as customer". | Phase 5 |
| Web app (ORVYN Cloud chat, billing portal) | None. `apps/` has only backend, desktop and worker. | Phase 3 / 4 |
| Transactional email | Verification only | Phase 1–2 (reset, receipts, dunning) |
| Backups | **`backup.sh` saves only Caddy data and `.env`.** `/data` (accounts, ledger, tenant DBs, workspaces), `/projects`, Postgres and Qdrant are not backed up. Nothing is stored off-host and there is no restore test. | **P0: phase 9, pulled forward** |
| Export / deletion / retention | Missing | Phase 8 |
| Error capture / metrics | Missing; redaction is only local | Phase 9 |
| Published run sites | Unauthenticated on the API origin, with secret HMAC ids (since cd383c7) | Phase 3: move to a separate preview origin |

### Service inventory (production host)

| Service | Purpose | State |
|---|---|---|
| backend | API, control plane, agent runtime | `orvyn-data:/data`, `orvyn-projects:/projects`, docker.sock |
| caddy | TLS and reverse proxy | 80/443 |
| postgres 16 | Migrated but unused | Default password in compose: **must be overridden** |
| redis 7 | No persistence (`--save ""`) | Fine for cache/queue |
| qdrant | Vectors | Not backed up |
| ollama | Local models | Optional |
| worker(s) | Mission containers | docker.sock |
| staging stack | Mirrors prod with `staging-*` volumes | — |

The deploy runs rsync, then an `.env` upsert, then `compose up -d --build`, then a health/commit check. **There is no pre-deploy backup and no migration step.**

## 2. Decisions

1. **One account everywhere.** Web and Desktop use the same `users`/`sessions`, the same personal org, the same wallet and the same onboarding profile. This already holds today (the same `auth.db` and onboarding API) and is non-negotiable going forward.
2. **Postgres becomes authoritative for identity and billing (phase 1b/2b), behind the current service interfaces.** `AuthService`, `CreditLedger` and `OnboardingStore` keep their method signatures, and a Postgres-backed implementation replaces the SQLite one. It is selected by `DATABASE_URL`, with a one-shot migrator from `auth.db`/`billing.sqlite`. Tenant work data (sessions, runs, workspaces) stays in per-tenant SQLite plus files on the durable volume until phase 7.
3. **The ledger is append-only.** A balance is `SUM(entries)`. Every entry has a unique `idempotency_key`. Entry types: `monthly_grant` (key `grant:<subscription>:<period_start>`), `topup_purchase` (key `stripe:<event>`), `mission_reservation`, `usage_settlement`, `reservation_release`, `refund`, `admin_adjustment` (staff id plus reason required), `expiration`. Rolling 5 h/7 d windows are sums over `usage_settlement` entries. There are no UPDATEs on money columns.
4. **Stripe webhooks are the only thing that changes paid state.** The checkout redirect only shows "processing". Webhooks are verified (HMAC with a timestamp tolerance), stored in `stripe_events` (a unique event id), and processed in one transaction. No card data touches ORVYN.
5. **Customers see ORVYN model names only.** AUTO/Fast/Reasoning/Code/Research/Vision map server-side to provider routes. Provider ids never reach the customer API or UI.
6. **Staff are a separate RBAC domain** (`staff_roles`: super_admin, billing_admin, support, read_only). Customer org roles never grant `/admin`. Every admin write is audit-logged.

## 3. Phases and order

| Phase | Scope | Gate to exit |
|---|---|---|
| **P0 (now)** | Close free plan/top-up grants. Hide OAuth buttons until the routes exist. Consistent `/data` backup plus an off-host hook. | API test: `POST /billing/plan` and `/billing/topup` are refused without payment |
| 1 | Password reset. Google/GitHub OAuth (state + PKCE, account linking by verified email). Refresh rotation, logout-all, device list. Desktop sign-in via system browser + PKCE with a single-use code. Org invites plus a viewer role. Roles enforced on billing/models. | auth E2E: reset, OAuth callback with a mocked provider, rotation replay detection, handoff code used once |
| 2 | Append-only ledger (schema above). Stripe checkout, webhook and subscription. Renewal grants. Top-ups. Auto-recharge with a cap. reserve → settle → release around every run. Premium-window fallback to economy with a clear message. Versioned plans and rate cards. | ledger property tests (no double grant/charge under replay, concurrency or failover); Stripe webhook E2E with signed fixtures |
| 3 | ORVYN Cloud web app: signup/login/onboarding (same API), conversational chat with persistent conversations, the same wallet | web E2E: sign up on the web, continue on desktop at the same step and with the same credits |
| 4 | Customer billing portal (plan, invoices through the Stripe portal, usage by model/project/day, top-ups, auto-recharge) | UI + API tests |
| 5 | `/admin`: customers, detail tabs, plan editor (versioned), ledger adjustments, account status, provider cost/margin, health, audit log, view-as (read-only, audited) | RBAC tests: customer → 403 everywhere |
| 6 | Customer model names, hybrid routing with failover, UsageEvent → settlement at ModelRate | a routing test shows no provider id in any customer response |
| 7 | Durable workspace storage `organizations/<orgId>/...`; nothing lost on worker restart | restart test |
| 8 | Transactional email set, dunning, retention, export, account deletion | E2E |
| 9 | Backups (hourly SQLite `.backup` + Postgres PITR/WAL), off-host copy, a scripted restore test, runbooks, error capture/metrics with redaction | restore drill passes on staging |
| 10 | Full E2E and security suite; the production-readiness report (38 items) | every gate green |

**Nothing is called production-ready until the phase 10 gates pass.**

## 4. What needs the owner

1. **Stripe live products/prices.** No live Stripe objects will be created without explicit confirmation. The code uses configured price ids (`STRIPE_PRICE_<PLAN>_<INTERVAL>`), and test mode works with a test key.
2. **Off-host backup target.** An S3-compatible bucket plus credentials (as GitHub secrets). Until one exists, backups stay on the host and that gap is reported as open.
3. **`STRIPE_WEBHOOK_SECRET`.** This comes from the webhook endpoint the owner registers in the Stripe dashboard: `https://<api-domain>/api/v1/billing/stripe/webhook`.

## 5. Progress log

| Date | Commit | Closed |
|---|---|---|
| 2026-09-29 | c63313c | Account gate, desktop and server: no app without an account, verified email and finished onboarding |
| 2026-09-29 | (this commit) | **Free plan/top-up grants removed** (410). **Append-only ledger v2**: balances are sums of immutable entries (UPDATE/DELETE blocked by triggers). Every entry has a unique idempotency key; grants are keyed by subscription + period + plan. A leftover included balance expires at each new grant. v1 balances migrate once. **Stripe**: Checkout from configured price ids only, portal, and a signature-verified webhook with an event table, so replays are no-ops. Invoices grant plans; top-ups and refunds are credited from payments; auto-recharge charges off-session and credits only on `payment_intent.succeeded`, capped monthly. **Metering**: a pre-call gate (balance, rolling 5 h/7 d windows, the run budget, entitlements) with a clear 402 and no provider failover. Settlement never throws after work is done: shortfalls are recorded and the balance never goes below zero. reserve → settle → release around every run. **Fixed a leak**: streams the runtime stopped reading were never metered, and streams without usage counts were free; both are now billed (estimated at about 4 characters per token when the provider reports nothing). |

Open billing items: dunning email (the hook exists, the template does not); premium-window fallback to economy (phase 6, needs customer model tiers); versioned plan editor (phase 5); moving `billing.sqlite`/`payments.sqlite` to Postgres (phase 2b); per-project usage attribution.
| 2026-09-29 | (models commit) | **Customer model catalog**: ORVYN Cloud shows six ORVYN models (Auto, Fast, Reasoning, Code, Research, Vision). Vendor names, registry ids and endpoints are removed at the edge from JSON, SSE run events and the chat socket; conversation content is never altered. ORVYN models are read-only (403 on edit, delete, test and route). **Customer-owned models** (`my:*`): any OpenAI-compatible API on a public https endpoint (SSRF guard: private, loopback, metadata and rebinding addresses refused). The key is sealed per tenant at rest and never returned. A model can be pinned per conversation or set as the default for Auto, and its calls use the customer's provider account, not ORVYN credits. ORVYN's routing and failover never land on a customer model. |
| 2026-09-29 | (auth commit) | **Identity phase 1.** Password reset (single-use 1 h link, same answer for unknown emails, all sessions end, security notice). **Google/GitHub sign-in** with state + PKCE (S256); an account is linked only by a provider-verified email; GitHub with no verified email is refused. **Desktop browser sign-in**: the app holds a secret verifier and the browser completes sign-in against a public handoff id; the app claims its session once, and no token ever travels in a URL. **Sessions**: device list, end one, sign out everywhere, rotation (`/auth/refresh`) with reuse detection after a 60 s grace window. The login lockout is persisted (survives restarts). Credential endpoints keep the strict IP limit; session reads and handoff polling get a looser one. **Connect GitHub** (repo scope) shares the single OAuth callback via a one-time link; the token is sealed in the tenant. Settings: the vendor mockup page (fake providers and fake meters) was replaced by the real model manager, billing and a Security page. |

Open identity items: the desktop does not auto-rotate yet (the local worker holds the session token; it needs its own worker credential first); org invites and the viewer role; roles enforced on billing/models (billing is owner/admin; model routes aren't role-gated); identity/billing to Postgres (phase 1b/2b).
