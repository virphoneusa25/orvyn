# Complete authentication storage migration

The current production authentication service remains SQLite-authoritative. This
change provides its complete PostgreSQL migration target, not a live authentication
switch. Global primary flags remain rejected by the production tenant store.

`orvyn_auth` covers all 26 business tables in the production auth.db contract: users,
sessions, organizations, membership, projects, chats, invitations, API keys,
share links, legal acceptances, verification/reset links, rotations, OAuth
identities/state, desktop handoffs, GitHub links and login failures, plus staff roles,
append-only admin audit, account suspensions, support notes, organization profiles,
view-as sessions, onboarding profiles and analytics events. Existing
`public.identity_*` tables remain separate; they lack the complete account data.

The checked-in catalog includes every column and primary/unique constraint plus
existing explicit indexes. Unknown source tables or schema changes fail closed.
Integer values must be exactly representable in JavaScript, and PostgreSQL TEXT
cannot represent null characters; an affected export fails without altering data.
Do not scrub source authentication records to bypass this check.

The source reader opens SQLite read-only and uses one consistent read transaction.
Audit update/delete protection is recreated in PostgreSQL, and TRUNCATE is blocked.
The SQLite AUTOINCREMENT
high-water mark is preserved, including gaps above the current maximum row; the
PostgreSQL identity sequence is restarted transactionally so retries remain safe.
The destination migration/import uses transactions, a shared advisory lock,
bounded statement/lock waits, and table locks for consistent cross-table checks.
Only an empty destination can be seeded. Identical repeated imports are safe;
differing data is rejected, including changes with unchanged row counts. All fields
are compared before commit through an order-independent content fingerprint.

## Private migration tooling

Run the compiled CLI against an authentication database from a protected backup.
The `--check` mode needs no PostgreSQL connection and prints table counts only:

```sh
node apps/backend/dist/identity/authMigrationCli.js --source /protected/auth.db --check
```

Set `ORVYN_AUTH_PG_URL` through the existing protected environment/secret mechanism,
then select either `--import` or `--verify` instead of `--check`. The dedicated URL
is intentional: the tool does not silently use the general production database URL.
`--verify` does not initialize or import the target. Commands report failure with a
nonzero exit status and avoid logging credential-bearing records or database error
details. The internal snapshot/export objects contain password hashes, hashed
tokens and OAuth verifiers; do not log, expose through HTTP, or save them unencrypted.

A backup snapshot imported while live SQLite continues to change is a rehearsal,
not a cutover. Final import requires a consistent final source with authentication
writes stopped, or a separately implemented and validated durable replication path.
This change does not provide ongoing authentication mirroring.

## Validation and next boundary

Tests populate all 26 tables/columns, check hashed credential storage, force an
import failure midway through the transaction, retry concurrent imports, reject
different existing data, detect schema drift and revocation changes at unchanged
counts, and restore PostgreSQL-exported rows into the current authentication service.
Recovered accounts retain password login, tenant resolution, API-key revocation,
single-use verification/OAuth/reset state and password-reset session invalidation.
CI also dumps/restores the new schema with the existing mirror and identity tables
and compares every table's content.

The asynchronous `PostgresAuthService` now provides the existing authentication
operations against this schema. Its implementation is generated from `AuthService.ts`
so password, token, tenant and portal rules share one source. Backend builds reject
stale generated output; regenerate with `node apps/backend/scripts/generate-postgres-auth.cjs`
after changing the source service. Importing this runtime does not instantiate the
SQLite service. Runtime connection validates the complete authentication schema.

Each public operation uses a PostgreSQL transaction. Nested operations share the
same connection through async context. A common advisory lock serializes operations
across instances and migrations, preserving atomic registration, invitation seat
limits, single-use token consumption and session rotation. This coarse lock is an
initial correctness boundary and limits throughput; contention has bounded timeouts.
Failed password logins commit their persistent failure counter before rejecting;
other errors roll back. Database failures propagate without a SQLite fallback.
WebSocket tickets retain the existing instance-local memory behavior and still
require a shared ticket store or instance affinity for multiple API instances.

Runtime integration tests exercise two independent service instances against real
PostgreSQL 16, including concurrent operations, lockout accounting, forced rollback
of registration and password reset, OAuth and desktop handoff consumption, tenant
isolation, invitation seats, API key revocation and session reuse detection.

The HTTP, middleware, CLI, provisioning, GitHub and WebSocket callers now await
the `AsyncAuthService` boundary. Its current lazy adapter preserves SQLite behavior;
it does not expose a PostgreSQL activation flag. Express 4 handlers forward rejected
promises to error middleware. WebSocket admission awaits ticket redemption, account
readiness and tenant authorization; premature messages are refused and admission
failures close the connection without exposing database details.

Next migrate the shared admin and onboarding stores and admin cross-store reporting.
Those stores still access auth.db directly and cannot safely be left behind during
an authentication cutover. The PostgreSQL runtime is not yet selected by requests.
A passing runtime test is not evidence of a completed live cutover.

`PostgresStaffStore` and `PostgresOnboardingStore` now provide the shared-store
operations using the same source-generation check as authentication. They preserve
staff roles and revocation, audit records, notes, suspension history, CRM fields,
support views, onboarding progress/answers and analytics filtering. Their public
operations use the same cross-instance advisory lock and transaction boundary.

`PostgresAccountStores.connect` validates one database and creates all three stores
with one pool and async transaction context. It seeds configured staff accounts in
that database and closes the pool on startup failure. Use its `transaction` method
for related account changes and audit writes; nested calls across the three stores
join the transaction. Any composite rejection rolls back every write, including
rejection from a nested login. Run password login independently when its failure
counter must persist; standalone login retains the commit-on-rejection behavior.
Close the shared owner after requests drain, rather than closing child stores.

Real PostgreSQL tests verify concurrent last-super-admin removal, staff revocation
of support views, single suspension under concurrent requests, audit-failure
rollback, append-only audit enforcement, merged CRM/onboarding updates, idempotent
profile creation/completion, analytics filtering and all-store commit/rollback.
These runtime implementations are not yet selected by the request adapters.
Next wire the shared stores and migrate AdminService cross-store reporting before
exposing an authentication activation flag. SQLite remains authoritative in production.
Billing and durable WorkSession integration remain separate prerequisites
for a full primary-storage rollout. No production flags are changed by this work.
