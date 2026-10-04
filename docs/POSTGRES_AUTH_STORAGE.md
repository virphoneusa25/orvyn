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

Next implement the asynchronous authentication repository operations and migrate
their callers together. Preserve atomic registration, invitation seat limits,
single-use token consumption, session rotation/reuse handling, and persistent login
failure accounting. Connect live requests only after those semantics pass against
PostgreSQL. Admin and onboarding callers also share auth.db and must migrate with it.
Billing and durable WorkSession integration remain separate prerequisites
for a full primary-storage rollout. No production flags are changed by this work.
