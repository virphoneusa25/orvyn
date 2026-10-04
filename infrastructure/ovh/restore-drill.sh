#!/usr/bin/env bash
# infrastructure/ovh/restore-drill.sh — prove the latest backup restores.
#
# Takes a backup directory (default: the newest under BACKUP_DIR), decrypts it
# if needed, verifies checksums, restores the SQLite snapshots into a scratch
# directory, and checks every database (integrity_check + row counts against
# the manifest written at backup time). Then boots a throwaway ORVYN backend
# on the restored data and checks /health and that accounts load.
# Nothing touches the live volumes.
#
# Usage: infrastructure/ovh/restore-drill.sh [BACKUP_PATH]
set -euo pipefail
cd "$(dirname "$0")/../.."
SRC="${1:-$(ls -1d "${BACKUP_DIR:-/var/backups/orvyn}"/*/ | sort | tail -1)}"
SRC="${SRC%/}"
WORK="$(mktemp -d /tmp/orvyn-restore-XXXX)"
CID=""
USERS="?"
record_drill() {
  [[ "${ORVYN_RESTORE_RECORD_STATUS:-1}" == 1 ]] || return 0
  docker compose -f docker-compose.yml -f infrastructure/ovh/compose.prod.yml exec -T -e D_STATUS="$1" -e D_USERS="$USERS" -e D_BACKUP="$(basename "$SRC")" backend \
    node -e 'const fs=require("fs"),p=require("path");const d=p.join(process.env.ORVYN_DATA_DIR||"/data",".ops");fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,"restore-drill.json"),JSON.stringify({status:process.env.D_STATUS,backup:process.env.D_BACKUP,accounts:process.env.D_USERS,at:Date.now()}))' >/dev/null 2>&1 || true
}
cleanup() {
  result=$?
  [[ -z "$CID" ]] || docker rm -f "$CID" >/dev/null 2>&1 || true
  [[ "$result" == 0 ]] || record_drill failed
  # WORK comes exclusively from mktemp above; never delete caller-supplied paths.
  [[ "$WORK" == /tmp/orvyn-restore-* ]] && rm -rf -- "$WORK"
}
trap cleanup EXIT
echo "[drill] backup: $SRC"
( cd "$SRC" && sha256sum -c --quiet SHA256SUMS )
echo "[drill] checksums OK"
cp "$SRC"/* "$WORK"/
for f in "$WORK"/*.enc; do
  [[ -e "$f" ]] || break
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$f" -out "${f%.enc}"
  rm -f "$f"
done
mkdir -p "$WORK/snap" "$WORK/data"
tar xzf "$WORK/sqlite.tgz" -C "$WORK/snap"
tar xzf "$WORK/data-files.tgz" -C "$WORK/data"
[[ -f "$WORK/env.bak" ]] || { echo "[drill] FAILED: matching backup environment is missing" >&2; exit 1; }
IMAGE="${ORVYN_RESTORE_IMAGE:-$(docker compose -f docker-compose.yml -f infrastructure/ovh/compose.prod.yml images -q backend | head -1)}"
[[ -n "$IMAGE" ]] || { echo "[drill] FAILED: backend image is missing" >&2; exit 1; }
run_node() { docker run --rm --network none -v "$WORK":/w -i --entrypoint node "$IMAGE" --no-warnings --input-type=module - "$@" < infrastructure/ovh/backup-data.mjs; }
run_node verify --dir /w/snap/sqlite --manifest /w/snap/manifest.json
run_node restore --from /w/snap --data /w/data --force
echo "[drill] booting a throwaway backend on the restored data"
# Retain the snapshot's matching vault key. Network isolation prevents restored
# integration credentials from reaching providers or production databases.
CID="$(docker run -d --network none --env-file "$WORK/env.bak" -v "$WORK/data":/data \
  -e ORVYN_DATA_DIR=/data -e ORVYN_CLOUD_MODE=true -e PORT=4999 \
  -e ORVYN_PG_URL= -e DATABASE_URL= -e ORVYN_POSTGRES_MIRROR=0 \
  -e ORVYN_POSTGRES_PRIMARY_READS=0 -e ORVYN_POSTGRES_PRIMARY_WRITES=0 "$IMAGE")"
ok=0
for _ in $(seq 1 40); do
  [[ "$(docker inspect -f '{{.State.Running}}' "$CID")" == true ]] || { echo "[drill] restored backend exited before health check" >&2; break; }
  if docker exec "$CID" node -e "fetch('http://127.0.0.1:4999/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then ok=1; break; fi
  sleep 2
done
USERS="$(docker exec "$CID" node --no-warnings -e "const {DatabaseSync}=require('node:sqlite');console.log(new DatabaseSync('/data/auth.db',{readOnly:true}).prepare('select count(*) n from users').get().n)" 2>/dev/null || echo "?")"
[[ "$ok" -eq 1 ]] || { echo "[drill] FAILED: the restored backend did not become healthy" >&2; exit 1; }
[[ "$USERS" =~ ^[0-9]+$ ]] || { echo "[drill] FAILED: restored accounts could not be read" >&2; exit 1; }
record_drill pass
echo "[drill] PASS: restored backend healthy; $USERS account(s) present"
