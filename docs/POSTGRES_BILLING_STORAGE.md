# PostgreSQL credit ledger migration

The active `billing.sqlite` contract covers ten tables: wallets, immutable ledger entries, usage events, rate cards, auto-recharge settings/requests, run budgets, image usage counts, image rate cards and image reservations. This migration does not select a PostgreSQL billing runtime or change plan, pricing, quota or Stripe behavior.

`LedgerStorageSnapshot` opens the source read-only and reads every table plus the AUTOINCREMENT high-water mark in one SQLite transaction. It validates table/column/key inventory, immutable-entry triggers and bucket protection. Integer credits/timestamps/counters must be safe integers; fractional prices use finite double precision. Text and nullable fields remain exact. Full-field fingerprints include every row and the sequence, including gaps; only counts appear in command output.

`PostgresLedgerStorage` uses the separate `orvyn_billing` schema with schema version 1. Import, verification and initialization serialize using advisory transaction lock `(730021, 3)`. Imports accept an empty target or identical repeated input, and refuse differing existing records. Inserts, the sequence restart, full verification and the import acknowledgement commit together. A late failure rolls back both rows and the ledger counter. Unique idempotency keys and append-only update/delete/truncate protections remain enforced. Export and verification refuse changed target inventory, column/key types, bucket constraints or disabled entry protections.

Build the backend, then use the compiled operator tool:

```sh
node apps/backend/dist/billing/ledgerMigrationCli.js --source /private/billing.sqlite --check
node apps/backend/dist/billing/ledgerMigrationCli.js --source /private/billing.sqlite --import
node apps/backend/dist/billing/ledgerMigrationCli.js --source /private/billing.sqlite --verify
```

Import and verify require `ORVYN_BILLING_PG_URL`; check needs no PostgreSQL connection. Use secret injection for the URL. The tool never prints financial records, URLs or PostgreSQL error details. Snapshot/export objects are private financial data and must not be logged.

The source must match the active contract. Unknown historical archives such as `v1_accounts` fail preflight rather than being silently discarded; archive compatibility must be explicitly handled before such a source can be imported. A final production migration requires stopping SQLite billing writes for a consistent cutover and verifying related Stripe payment records together. There is no ongoing billing replication in this implementation.

Tests against PostgreSQL 16 cover all ten tables, fractional prices, reservations, Unicode metadata, ledger sequence gaps, duplicate-key rollback, failed acknowledgement rollback, concurrent import, conflicting re-import refusal, SQLite restoration with exact balances and entry history, new-entry counter continuity, immutable entry enforcement and disabled-trigger refusal. CI backs up and restores all ten tables plus migration metadata and checks the ledger sequence separately.

Remaining work: migrate the Stripe payment store; build an asynchronous PostgreSQL ledger/payment runtime with acknowledged wallet/reservation/webhook transactions; connect callers; migrate durable sessions; replace AdminService cross-store SQLite reports; then rehearse consistent import, backup/rollback and staged activation. SQLite remains authoritative until those steps pass.

## Stripe payment migration

The complete payments.sqlite contract covers stripe_customers, stripe_events, stripe_checkouts and stripe_subscriptions. StripeStorageSnapshot opens the source read-only and exports every field in one SQLite transaction, validating table/column/key inventory and safe integer timestamps. Text, nulls, customer/email mappings, payment-intent/subscription links, cancellation flags, event statuses and failure details are preserved exactly. Full-field fingerprints are independent of row/column ordering.

PostgresStripeStorage uses the separate orvyn_payments schema, version 1, and advisory transaction lock (730021, 4). Import accepts an empty target or an identical repeat; differing existing records are refused. All four tables, full verification and import acknowledgement commit together. Concurrent imports apply once. Unique customer and webhook identifiers remain enforced. Export/verification refuse unexpected target tables and column/key drift.

The compiled stripeMigrationCli supports --source PAYMENTS_DB followed by --check, --import or --verify. Check needs no PostgreSQL connection; import/verify require ORVYN_PAYMENTS_PG_URL through secret injection. Output includes aggregate counts and whether content matches, never customer records, payment identifiers, URLs or database error details. Export objects are private payment data and must not be logged.

Tests restore PostgreSQL-exported rows into SQLite and verify the existing StripeStore behavior: processed webhooks refuse replay; failed, ignored and received events retain their current retry behavior; customer/account lookups, payment-intent checkout lookup, annual subscription period and cancellation flags remain intact. Duplicate-key and late acknowledgement failures roll back the entire import; concurrent repeats apply once; conflicting imports and unknown target schemas are refused. CI restores and compares these four tables and both migration metadata tables alongside account and ledger data.

This is migration tooling only. It does not call Stripe, change payment processing, replicate live writes or activate PostgreSQL billing. Next implement a shared asynchronous ledger/payment runtime and acknowledged webhook/grant transactions, then connect callers. Final consistent imports of billing.sqlite and payments.sqlite require quiescing both writers or proving a common consistent snapshot; separate successful imports alone do not establish cross-store transactional consistency. Durable sessions, admin reporting, backup/rollback and activation rehearsals remain required.

## PostgreSQL payment runtime and shared transaction boundary

PostgresBillingDatabase owns one pool and asynchronous transaction context for orvyn_billing and orvyn_payments. Initialization validates both complete migration contracts before returning the owner. Every outer transaction acquires the ledger migration lock followed by the payment migration lock, then sets the local search path to pg_catalog and the two financial schemas. Nested store calls use the same connection and transaction. There is no SQLite fallback.

PostgresStripeStore is generated from the existing StripeStore methods, preserving customer mapping, subscription period updates, event replay/retry semantics and reporting behavior. The backend build checks generated-source freshness. Importing the module opens no local database. Create one PostgresBillingDatabase owner and pass it to PostgresStripeStore.fromDatabase; close the owner after draining operations. Child stores do not independently close its pool.

Standalone payment operations commit before their promises resolve. A composite operation uses database.transaction around awaited store operations and ledger operations on that same owner. Rejected operations roll back together. COMMIT must return PostgreSQL's COMMIT result: an aborted transaction returning ROLLBACK is rejected even if a callback caught the original SQL error. Detached operations retaining a finished asynchronous context are rejected instead of using a released connection. Integer results and bigint aggregates normalize only within the supported safe range.

The SQL adapter covers the existing StripeStore's insert-ignore, placeholders and subscription upsert syntax. It does not claim to support every CreditLedger query yet. The transaction locks serialize financial operations across instances and migrations; throughput tuning must retain correctness and consistent lock order.

PostgreSQL 16 tests verify cross-instance customer/checkout/subscription state, preserving prior period boundaries on partial subscription updates, event retries and numeric report results. A synthetic composite webhook/ledger transaction credits once under concurrency, rolls both records back on rejection, rejects false commit acknowledgement after a caught SQL error, and prevents detached work after commit. Initialization refuses incompatible ledger storage without local fallback.

This phase provides the payment runtime and shared transaction foundation. The composite test uses synthetic ledger SQL; it is not a replacement for the full CreditLedger runtime. Remaining: port all ledger methods, preserve reservation/settlement/recharge behavior including external effects after commit, connect the BillingService and callers, then migrate durable sessions and admin reports. External Stripe HTTP requests must not be held inside the coarse database transaction; fetch/validate first, then commit internal state atomically. Production backend selection and billing activation remain disabled.
