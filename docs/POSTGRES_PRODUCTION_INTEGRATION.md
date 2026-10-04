# PostgreSQL production integration

The October 4 production inspection identified a source-line mismatch:

- Live API: `04394b21f47e4ec96f57138dcb2212173214d765` (version 0.2.0).
- Storage experiment: PR #6, `ea04d8511ce59e74180bb9afc91b14052c71c910`.
- The experiment removes/replaces extensive live auth, routes, worker and billing behavior when compared directly with the deployed source. Its green CI is not evidence of compatibility with that source.

Do not deploy PR #2/#5/#6 sources over the current production directory. Port reviewed functionality into the production code line, with its existing acceptance gates. This integration starts from the exact live SHA and preserves the current provider lineup, credit ledger, organization/session system, portals and worker topology.

## This integration: tenant-data mirror only

SQLite remains authoritative. The optional mirror copies tenant missions, usage events, settings and custom-model configuration into the isolated `orvyn_storage` schema in the existing PostgreSQL database. The `identity_*` tables are preserved.

Backfill runs when a tenant LocalStore is materialized, before that instance's subsequent mirror writes. It includes all local history, beyond the Reports window. Inactive tenants are not automatically materialized; counts on one tenant do not prove global migration coverage. Existing historical SQLite events lack some billing metadata; the mirror never manufactures it or replaces richer previously mirrored payloads with the legacy representation.

New usage payloads retain all current fields, including embeddings, cached tokens, rate snapshots, provider-settled cost and image counts. Credential configs retain the production `apiKeySealed` vault format; plaintext local configs are sealed using the existing tenant-bound `ORVYN_VAULT_KEY` before being sent to PostgreSQL. Do not rotate or replace that existing key as part of this rollout.

Mirror failures do not block authoritative SQLite writes. Failed tenants remain degraded until a successful full backfill repairs missing writes/deletions. Migration locking serializes simultaneous startup. Five-second connection/lock and ten-second statement deadlines bound database operations.

`GET /api/v1/storage/status`, under the existing authentication/tenant middleware, reports the tenant's covered families, row-count parity and pending/failed mirror work. Its count parity is not a content-equivalence or complete-cloud-cutover claim.

Identity/auth, credit/Stripe ledgers, WorkSessions, checkpoints, artifacts, memory, learning and other product entities are not switched by this change. They must be integrated into the full storage design before PostgreSQL-primary mode can be enabled. Startup rejects primary flags to prevent silently operating in an unsupported mode.

## Candidate rollout after review

Use the existing production deployment pipeline and all its Compose overlays. Preserve `.env`, its current `ORVYN_PG_URL` / database credentials, `ORVYN_VAULT_KEY`, named volumes and model/provider configuration.

1. Run the complete production workspace builds, regression suite, exact-billing acceptance and new real PostgreSQL integration tests. Validate the current Compose overlay stack and restore both identity and mirror schema into an isolated database.
2. Take and verify the existing production backup; preserve the running image for rollback.
3. Deploy this compatible commit with `ORVYN_POSTGRES_MIRROR=0` and both primary flags `=0`. Verify the exact live health SHA, existing signup/login, portals, worker execution, billing and Desktop connectivity.
4. Enable `ORVYN_POSTGRES_MIRROR=1` only for a controlled storage canary. Recreate the backend with the same complete production overlay list; a restart does not reload the environment. Verify per-tenant counts and durable metadata, then observe normal writes and one controlled database outage.
5. Inventory/backfill inactive tenants and all remaining stores before designing the full production primary cutover. Port the reviewed atomic quota reservation behavior into the current provider/worker/billing boundaries rather than replacing them with the old classes.

No Redis role or LiteLLM activation is required for this mirror canary. Those are separate topology changes. Do not treat the existing generic Redis (`allkeys-lru`, no persistence in the old control-plane overlay) as the dedicated BullMQ Redis from PR #2.

## Rollback

For this mirror-only integration, set `ORVYN_POSTGRES_MIRROR=0` and recreate the backend through the established overlay/deploy path. SQLite, the production identity/credit stores and named volumes remain authoritative and unchanged. Preserve the new schema for diagnosis; do not drop it or delete customer volumes.

A full production failover drill and PostgreSQL-native ledger/identity consistency remain rollout requirements for future primary modes.

## Restore-drill repair

The production backup service succeeded on October 4, but the scheduled restore drill failed. Its journal verified all 25 SQLite databases, then the throwaway backend disappeared before health checks. Inspection found that the drill did not supply the vault environment required by the current production backend, and automatic container removal masked its exit. This identifies a concrete boot defect; the removed container's original exception is unavailable.

The candidate drill loads the matching backed-up environment, including its original vault key, with networking disabled and PostgreSQL storage flags off. It mounts only scratch data, retains the container until cleanup, detects early exits, records failures, and rejects checksum errors or missing environment archives. CI boots the actual production image on a synthetic restored account and verifies unhealthy input fails closed. No live restore or server update has been performed. The server's scheduled drill must pass after the reviewed repair is deployed before mirror activation.

## Historical null-character compatibility

The production inventory identified escaped null characters in historical mission/tool output. PostgreSQL JSONB rejects them with error 22P05. Schema version 2 stores mission/usage payloads and model configurations as PostgreSQL JSON, which retains the escaped data exactly. Migration runs under the existing transaction/advisory lock, preserves v1 rows and changes no identity or credit tables. Integration tests start from the deployed v1 JSONB layout and verify concurrent upgrade, preserved rows, and null-character mission/model round trips. SQLite remains authoritative throughout.
