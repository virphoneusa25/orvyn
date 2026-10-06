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
