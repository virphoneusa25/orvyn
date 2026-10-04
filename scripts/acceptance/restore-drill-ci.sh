#!/usr/bin/env bash
# Exercise the production drill with synthetic data and a synthetic vault key.
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${ORVYN_RESTORE_IMAGE:?candidate backend image is required}"
export ORVYN_RESTORE_RECORD_STATUS=0
FIXTURE="$(mktemp -d /tmp/orvyn-drill-ci-XXXX)"
trap '[[ "$FIXTURE" == /tmp/orvyn-drill-ci-* ]] && rm -rf -- "$FIXTURE"' EXIT
mkdir -p "$FIXTURE/data" "$FIXTURE/backup" "$FIXTURE/snap" "$FIXTURE/files"
docker run --rm --user "$(id -u):$(id -g)" --network none -v "$FIXTURE/data:/data" -e ORVYN_DATA_DIR=/data --entrypoint node "$ORVYN_RESTORE_IMAGE" \
  -e "const {AuthService}=require('./dist/auth/AuthService.js'); const auth=new AuthService('/data'); auth.register('restore-fixture@example.test','Synthetic-fixture-password-42','Restore fixture');"
docker run --rm --user "$(id -u):$(id -g)" --network none -v "$FIXTURE:/w" -i --entrypoint node "$ORVYN_RESTORE_IMAGE" \
  --no-warnings --input-type=module - snapshot --data /w/data --out /w/snap < infrastructure/ovh/backup-data.mjs
tar czf "$FIXTURE/backup/sqlite.tgz" -C "$FIXTURE/snap" .
tar czf "$FIXTURE/backup/data-files.tgz" -C "$FIXTURE/files" .
# Random key, generated only for this synthetic backup. Never copy a live key.
node -e "console.log('ORVYN_VAULT_KEY='+require('crypto').randomBytes(32).toString('base64'))" > "$FIXTURE/backup/env.bak"
(cd "$FIXTURE/backup" && sha256sum sqlite.tgz data-files.tgz env.bak > SHA256SUMS)
bash infrastructure/ovh/restore-drill.sh "$FIXTURE/backup" | tee "$FIXTURE/result.log"
grep -F "PASS: restored backend healthy; 1 account(s) present" "$FIXTURE/result.log"
# Missing snapshot environment and corrupted checksums must fail closed.
mv "$FIXTURE/backup/env.bak" "$FIXTURE/env.bak"
(cd "$FIXTURE/backup" && sha256sum sqlite.tgz data-files.tgz > SHA256SUMS)
if bash infrastructure/ovh/restore-drill.sh "$FIXTURE/backup"; then echo "missing env accepted" >&2; exit 1; fi
mv "$FIXTURE/env.bak" "$FIXTURE/backup/env.bak"
(cd "$FIXTURE/backup" && sha256sum sqlite.tgz data-files.tgz env.bak > SHA256SUMS)
printf 'corruption' >> "$FIXTURE/backup/sqlite.tgz"
if bash infrastructure/ovh/restore-drill.sh "$FIXTURE/backup"; then echo "corrupt archive accepted" >&2; exit 1; fi
echo "Restore drill boot and fail-closed regression checks passed"
