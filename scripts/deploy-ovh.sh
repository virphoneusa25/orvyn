#!/usr/bin/env bash
# Ship backend + worker source to the live OVH control plane and rebuild.
# Never copies .env. Postgres/Redis/Qdrant data stay on named volumes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${OVH_HOST:-ubuntu@40.160.11.123}"
KEY="${OVH_SSH_KEY:-$HOME/.ssh/github_virphone}"
REMOTE="${OVH_REMOTE_DIR:-/home/ubuntu/orvyn}"
PUBLIC_HEALTH="${OVH_HEALTH_URL:-https://orvyn.virphoneusa.com/api/v1/health}"

if [[ ! -f "$KEY" ]]; then
  echo "OVH SSH key not found at $KEY. Set OVH_SSH_KEY." >&2
  exit 1
fi

SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
RSH="${SSH[*]}"

# Stamp the build so /api/v1/health says exactly which commit is live.
COMMIT="${GITHUB_SHA:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)}"
printf '{"commit":"%s","builtAt":"%s"}\n' "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$ROOT/apps/backend/build-info.json"

echo "Syncing $ROOT → $HOST:$REMOTE (preserving remote .env)"

"${SSH[@]}" "$HOST" "mkdir -p '$REMOTE/apps/backend' '$REMOTE/apps/worker' '$REMOTE/packages' '$REMOTE/infrastructure' '$REMOTE/scripts' '$REMOTE/resources'"

rsync -az --delete -e "$RSH" \
  --exclude node_modules/ --exclude dist/ --exclude '*.log' \
  "$ROOT/apps/backend/" "$HOST:$REMOTE/apps/backend/"

rsync -az --delete -e "$RSH" \
  --exclude node_modules/ --exclude dist/ --exclude '*.log' \
  "$ROOT/apps/worker/" "$HOST:$REMOTE/apps/worker/"

rsync -az --delete -e "$RSH" \
  --exclude node_modules/ --exclude dist/ \
  "$ROOT/packages/" "$HOST:$REMOTE/packages/"

rsync -az --delete -e "$RSH" \
  "$ROOT/infrastructure/" "$HOST:$REMOTE/infrastructure/"

# The backend image copies resources/skills. The OVH build context is this
# partial sync, not a git checkout, so the directory has to be sent explicitly.
rsync -az --delete -e "$RSH" \
  "$ROOT/resources/" "$HOST:$REMOTE/resources/"

rsync -az -e "$RSH" \
  "$ROOT/docker-compose.yml" \
  "$ROOT/package.json" \
  "$ROOT/package-lock.json" \
  "$ROOT/.env.example" \
  "$HOST:$REMOTE/"

echo "Rebuilding backend + worker on $HOST"
"${SSH[@]}" "$HOST" "set -euo pipefail
cd '$REMOTE'
docker compose \
  -f docker-compose.yml \
  -f infrastructure/ovh/compose.prod.yml \
  -f infrastructure/ovh/compose.control-plane.yml \
  -f infrastructure/ovh/compose.worker.yml \
  up -d --build --no-deps backend worker
docker compose \
  -f docker-compose.yml \
  -f infrastructure/ovh/compose.prod.yml \
  -f infrastructure/ovh/compose.control-plane.yml \
  -f infrastructure/ovh/compose.worker.yml \
  ps
"

echo "Waiting for $PUBLIC_HEALTH"
ok=0
for _ in $(seq 1 40); do
  if curl -fsS -m 8 "$PUBLIC_HEALTH" | grep -q '"status":"ok"'; then
    ok=1
    break
  fi
  sleep 3
done
if [[ "$ok" -ne 1 ]]; then
  echo "Public health check failed after rebuild" >&2
  curl -sS -m 8 "$PUBLIC_HEALTH" || true
  exit 1
fi
echo "OVH deploy healthy: $PUBLIC_HEALTH"
curl -sS -m 8 "$PUBLIC_HEALTH"
echo
if ! curl -fsS -m 8 "$PUBLIC_HEALTH" | grep -q "\"commit\":\"$COMMIT\""; then
  echo "The public health check does not report commit $COMMIT: the new build is not the one serving traffic." >&2
  exit 1
fi
echo "Live commit: $COMMIT"

echo "Building orvyn-desktop image on $HOST"
if ! "${SSH[@]}" "$HOST" "cd '$REMOTE/infrastructure/desktop' && docker build -t orvyn-desktop:latest ."; then
  echo "Desktop image build failed. Existing sessions keep the previous orvyn-desktop image until the next successful build." >&2
fi
