# Runbook: backups and restore

Internal operations document. Never share host names, addresses or provider details with customers.

## What is backed up

`infrastructure/ovh/backup.sh` runs **hourly** (systemd `orvyn-backup.timer`) and **before every deploy**. If the pre-deploy backup fails, the deploy is aborted.

| Source | Contents | How |
|---|---|---|
| `/data` SQLite | `auth.db` (accounts, sessions, orgs, onboarding); `billing.sqlite` (the credit ledger); `payments.sqlite` (Stripe customers, events, subscriptions); per-tenant `<tenant>.db`, `<tenant>-sessions.db` | `VACUUM INTO` inside the running backend, so each snapshot is consistent while ORVYN serves traffic. Then `integrity_check`, sha256 and row counts go into `manifest.json` |
| `/data` files | workspaces, run logs, previews, vectors | `data-files.tgz`, which excludes the live database files |
| `/projects` | cloud project folders | `projects.tgz` |
| Postgres | identity schema (not authoritative yet) | `pg_dump -Fc` |
| Qdrant | vectors (derived data: re-indexing rebuilds them) | best-effort tar |
| Caddy, `.env` | TLS certificates, secrets | tar / copy (mode 600) |

**Encryption:** when `BACKUP_PASSPHRASE` is set, every file is encrypted with AES-256-CBC and PBKDF2 (200k iterations). An off-host upload refuses to run without encryption.

**Off-host copy:** set `BACKUP_S3_URI` to `s3://bucket/prefix` (any S3-compatible store). A non-AWS store also needs `BACKUP_S3_ENDPOINT`, plus `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. These values live in `.backup.env` (mode 600), which the deploy writes from the matching GitHub secrets.

**Retention:** the last `BACKUP_KEEP` backups (default 48, i.e. two days of hourly backups) are kept locally. For off-host copies, set lifecycle rules on the bucket; 30 days is recommended.

Backups live in `/var/backups/orvyn/<UTC stamp>-<tag>/`.

## Restore drill (weekly, automatic)

`orvyn-restore-drill.timer` runs `infrastructure/ovh/restore-drill.sh` every Sunday at 04:30. The drill:

1. Verifies `SHA256SUMS` and decrypts the backup.
2. Restores the SQLite snapshots into a scratch directory.
3. Checks every database's integrity and row counts against the manifest.
4. Boots a throwaway backend on the restored data and requires `/health` to pass and the accounts to load.

It never touches the live volumes. To run it by hand: `sudo -E infrastructure/ovh/restore-drill.sh [/var/backups/orvyn/<stamp>]`.

## Restoring production (incident)

1. **Stop writes:**
   ```
   docker compose -f docker-compose.yml -f infrastructure/ovh/compose.prod.yml -f infrastructure/ovh/compose.control-plane.yml -f infrastructure/ovh/compose.worker.yml stop backend worker
   ```
2. **Pick the backup.** Use the newest one taken before the incident. If this host is gone, fetch it with `aws s3 cp --recursive` from off-host storage first.
3. **Run the drill** on that backup (step above). Do not restore a backup that fails the drill.
4. **Keep the current data:**
   ```
   docker run --rm -v <project>_orvyn-data:/data -v /var/backups/orvyn:/b alpine tar czf /b/pre-restore-$(date -u +%s).tgz -C /data .
   ```
5. **Restore into the volume.** Decrypt the files first if they are `.enc`. Then:
   ```
   docker run --rm -v <project>_orvyn-data:/data -v <backup-dir>:/b alpine sh -c 'rm -rf /data/* && tar xzf /b/data-files.tgz -C /data && mkdir /tmp/s && tar xzf /b/sqlite.tgz -C /tmp/s && cp -a /tmp/s/sqlite/. /data/'
   ```
   Restore `/projects` the same way from `projects.tgz`. For Postgres: `pg_restore --clean -d orvyn < postgres.dump`.
6. **Start and check:** `... up -d backend worker`, then check `/api/v1/health` and sign in with a test account.
7. **Reconcile payments.** Stripe is the source of truth for anything paid after the backup was taken. Replay those webhooks from the Stripe dashboard (Developers → Events → Resend). The ledger's idempotency keys make replays safe.

## Point-in-time recovery

SQLite files currently give **hourly** recovery points; the RPO is up to one hour. Finer-grained recovery arrives when accounts and the ledger move to Postgres (audit phase 2b) with WAL archiving. Until then, the hourly timer plus the pre-deploy backup are the recovery points.

## Checks

- `systemctl list-timers | grep orvyn`: both timers are scheduled.
- `journalctl -u orvyn-backup --since today`: each run ends with `done`. A run that warns `no off-host copy` means off-host storage is not configured yet.
- `journalctl -u orvyn-restore-drill`: the last run ends with `PASS`.
