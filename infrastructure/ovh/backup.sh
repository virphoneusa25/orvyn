#!/usr/bin/env bash
# infrastructure/ovh/backup.sh
# Backs up everything stateful on a single-VM ORVYN deployment:
#   - caddy-data volume (TLS certificates)
#   - .env (secrets — keep the backup somewhere safe, it contains keys)
# Usage: ./infrastructure/ovh/backup.sh [output-dir]   (default: ./backups)
set -euo pipefail

cd "$(dirname "$0")/../.."
OUT="${1:-./backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"

# Volume name is <project>_caddy-data; resolve it instead of hard-coding.
VOLUME="$(docker volume ls --format '{{.Name}}' | grep -m1 'caddy-data' || true)"
if [ -n "$VOLUME" ]; then
  docker run --rm -v "$VOLUME":/data -v "$(pwd)/$OUT":/backup alpine \
    tar czf "/backup/caddy-data-$STAMP.tgz" -C / data
  echo "caddy-data -> $OUT/caddy-data-$STAMP.tgz"
else
  echo "warning: no caddy-data volume found (is the stack running?)"
fi

if [ -f .env ]; then
  cp .env "$OUT/env-$STAMP.bak"
  chmod 600 "$OUT/env-$STAMP.bak"
  echo ".env -> $OUT/env-$STAMP.bak (contains secrets — protect this file)"
fi

# When PostgreSQL is added (cloud tier), add here:
#   docker compose exec -T postgres pg_dump -U orvyn orvyn | gzip > "$OUT/pg-$STAMP.sql.gz"

echo "done"
