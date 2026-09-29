#!/usr/bin/env bash
# infrastructure/ovh/backup.sh — back up everything that holds customer data.
#
#   /data  (orvyn-data volume): accounts (auth.db), the credit ledger
#          (billing.sqlite), payments (payments.sqlite), every tenant's
#          sessions / memory / runs / workspaces / previews
#   /projects (orvyn-projects volume): cloud project folders
#   postgres: pg_dump (custom format)
#   qdrant:   the vector store (derived data; rebuilt by re-indexing if lost)
#   caddy-data (TLS certificates) and .env (secrets)
#
# SQLite databases are copied with VACUUM INTO inside the running backend
# (a consistent snapshot, safe while ORVYN is serving), then verified
# (integrity_check, checksums, row counts) before the backup counts as good.
#
# Usage: infrastructure/ovh/backup.sh [--tag NAME] [--out DIR]
# Env:   BACKUP_DIR (default /var/backups/orvyn), BACKUP_KEEP (default 48)
#        BACKUP_PASSPHRASE   encrypt archives (AES-256, PBKDF2) — required for off-host copies
#        BACKUP_S3_URI       s3://bucket/prefix  (off-host copy; any S3-compatible store)
#        BACKUP_S3_ENDPOINT  https://… for non-AWS S3; AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
set -euo pipefail

cd "$(dirname "$0")/../.."
TAG="scheduled"
OUT_BASE="${BACKUP_DIR:-/var/backups/orvyn}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --out) OUT_BASE="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$TAG"
OUT="$OUT_BASE/$STAMP"
mkdir -p "$OUT"
chmod 700 "$OUT_BASE" "$OUT"
COMPOSE=(docker compose -f docker-compose.yml -f infrastructure/ovh/compose.prod.yml -f infrastructure/ovh/compose.control-plane.yml -f infrastructure/ovh/compose.worker.yml)
log() { echo "[backup $STAMP] $*"; }

# Status for the Admin Portal (Operations → Backups), written into the data
# volume through the running backend. No host, path or bucket names.
record_status() {
  "${COMPOSE[@]}" exec -T -e B_STATUS="$1" -e B_STAMP="$STAMP" -e B_TAG="$TAG" -e B_SIZE="${2:-}" -e B_ENC="${BACKUP_PASSPHRASE:+1}" -e B_OFF="${BACKUP_S3_URI:+1}" backend \
    node -e 'const fs=require("fs"),p=require("path");const d=p.join(process.env.ORVYN_DATA_DIR||"/data",".ops");fs.mkdirSync(d,{recursive:true});const s={status:process.env.B_STATUS,stamp:process.env.B_STAMP,tag:process.env.B_TAG,size:process.env.B_SIZE||null,encrypted:!!process.env.B_ENC,offHost:!!process.env.B_OFF,at:Date.now()};fs.writeFileSync(p.join(d,"backup-status.json"),JSON.stringify(s));let h=[];try{h=JSON.parse(fs.readFileSync(p.join(d,"backup-history.json"),"utf8"))}catch{};h.push(s);fs.writeFileSync(p.join(d,"backup-history.json"),JSON.stringify(h.slice(-96)))' >/dev/null 2>&1 || true
}
trap 'record_status failed' ERR
volume() { docker volume ls --format '{{.Name}}' | grep -m1 -E "(^|_)$1\$" || true; }

# 1. Consistent SQLite snapshots, taken by the backend itself.
STAGE="/data/.backup-staging/$STAMP"
log "snapshotting SQLite databases"
"${COMPOSE[@]}" exec -T backend node --no-warnings --input-type=module - snapshot --data /data --out "$STAGE" < infrastructure/ovh/backup-data.mjs
"${COMPOSE[@]}" exec -T backend node --no-warnings --input-type=module - verify --dir "$STAGE/sqlite" --manifest "$STAGE/manifest.json" < infrastructure/ovh/backup-data.mjs

DATA_VOL="$(volume orvyn-data)"
PROJ_VOL="$(volume orvyn-projects)"
[[ -n "$DATA_VOL" ]] || { echo "orvyn-data volume not found" >&2; exit 1; }

# 2. Archives: the snapshots, the rest of /data (without live database files), /projects.
log "archiving /data"
docker run --rm -v "$DATA_VOL":/data:ro -v "$OUT":/backup alpine sh -c "
  set -e
  tar czf /backup/sqlite.tgz -C '$STAGE' .
  tar czf /backup/data-files.tgz -C /data \
    --exclude='./.backup-staging' --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' \
    --exclude='*.sqlite' --exclude='*.sqlite-wal' --exclude='*.sqlite-shm' .
"
docker run --rm -v "$DATA_VOL":/data alpine rm -rf "$STAGE"
if [[ -n "$PROJ_VOL" ]]; then
  log "archiving /projects"
  docker run --rm -v "$PROJ_VOL":/projects:ro -v "$OUT":/backup alpine tar czf /backup/projects.tgz -C /projects .
fi

# 3. Postgres and Qdrant, when present.
if "${COMPOSE[@]}" ps --services --status running 2>/dev/null | grep -qx postgres; then
  log "dumping postgres"
  "${COMPOSE[@]}" exec -T postgres sh -c 'pg_dump -U "${POSTGRES_USER:-orvyn}" -Fc "${POSTGRES_DB:-orvyn}"' > "$OUT/postgres.dump"
fi
QDRANT_VOL="$(volume qdrant-data)"
if [[ -n "$QDRANT_VOL" ]]; then
  docker run --rm -v "$QDRANT_VOL":/q:ro -v "$OUT":/backup alpine tar czf /backup/qdrant.tgz -C /q . || log "qdrant archive skipped (derived data)"
fi
CADDY_VOL="$(volume caddy-data)"
[[ -n "$CADDY_VOL" ]] && docker run --rm -v "$CADDY_VOL":/c:ro -v "$OUT":/backup alpine tar czf /backup/caddy-data.tgz -C /c .
[[ -f .env ]] && install -m 600 .env "$OUT/env.bak"

# 4. Encrypt (required before anything leaves this machine), checksum.
if [[ -n "${BACKUP_PASSPHRASE:-}" ]]; then
  for f in "$OUT"/*; do
    [[ "$f" == *.enc ]] && continue
    openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -in "$f" -out "$f.enc"
    rm -f "$f"
  done
fi
( cd "$OUT" && sha256sum * > SHA256SUMS )
chmod 600 "$OUT"/*
log "local backup complete: $OUT ($(du -sh "$OUT" | cut -f1))"

# 5. Off-host copy.
if [[ -n "${BACKUP_S3_URI:-}" ]]; then
  if [[ -z "${BACKUP_PASSPHRASE:-}" ]]; then
    echo "refusing to upload an unencrypted backup: set BACKUP_PASSPHRASE" >&2
    exit 1
  fi
  log "uploading to off-host storage"
  docker run --rm -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}" \
    -v "$OUT":/b:ro amazon/aws-cli s3 cp --recursive /b "${BACKUP_S3_URI%/}/$STAMP/" \
    ${BACKUP_S3_ENDPOINT:+--endpoint-url "$BACKUP_S3_ENDPOINT"} --only-show-errors
  log "off-host copy: ${BACKUP_S3_URI%/}/$STAMP/"
else
  log "WARNING: no off-host copy (BACKUP_S3_URI not set) — a lost server loses its backups too"
fi

# 6. Retention (local).
KEEP="${BACKUP_KEEP:-48}"
ls -1d "$OUT_BASE"/*/ 2>/dev/null | sort | head -n -"$KEEP" | xargs -r rm -rf
record_status ok "$(du -sh "$OUT" | cut -f1)"
log "done"
