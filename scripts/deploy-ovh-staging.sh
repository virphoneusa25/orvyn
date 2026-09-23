#!/usr/bin/env bash
# Deploy the isolated staging control plane. Never touches production volumes,
# production .env, or production postgres/redis data.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${OVH_HOST:-ubuntu@40.160.11.123}"
KEY="${OVH_SSH_KEY:-$HOME/.ssh/github_virphone}"
REMOTE="${OVH_REMOTE_DIR:-/home/ubuntu/orvyn}"
STAGING_HEALTH="${STAGING_HEALTH_URL:-https://staging.orvyn.virphoneusa.com/api/v1/health}"

if [[ ! -f "$KEY" ]]; then
  echo "OVH SSH key not found at $KEY. Set OVH_SSH_KEY." >&2
  exit 1
fi

SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
RSH="${SSH[*]}"

echo "Syncing staging sources → $HOST:$REMOTE (production .env is not copied)"

"${SSH[@]}" "$HOST" "mkdir -p '$REMOTE/apps/backend' '$REMOTE/packages' '$REMOTE/infrastructure' '$REMOTE/scripts'"

rsync -az --delete -e "$RSH" \
  --exclude node_modules/ --exclude dist/ --exclude '*.log' \
  "$ROOT/apps/backend/" "$HOST:$REMOTE/apps/backend/"

rsync -az --delete -e "$RSH" \
  --exclude node_modules/ --exclude dist/ \
  "$ROOT/packages/" "$HOST:$REMOTE/packages/"

rsync -az --delete -e "$RSH" \
  "$ROOT/infrastructure/" "$HOST:$REMOTE/infrastructure/"

rsync -az -e "$RSH" \
  "$ROOT/docker-compose.yml" \
  "$ROOT/package.json" \
  "$ROOT/package-lock.json" \
  "$ROOT/.env.example" \
  "$HOST:$REMOTE/"

echo "Ensuring isolated staging secrets and reloading Caddy + staging stack"
"${SSH[@]}" "$HOST" "set -euo pipefail
cd '$REMOTE'
if [[ ! -f .env.staging ]]; then
  STAGING_KEY=\$(openssl rand -hex 32)
  STAGING_PG=\$(openssl rand -hex 24)
  umask 077
  cat > .env.staging <<EOF
ORVYN_ENV=staging
ORVYN_CLOUD_MODE=true
ORVYN_API_KEY=\${STAGING_KEY}
STAGING_PG_PASSWORD=\${STAGING_PG}
ORVYN_PUBLIC_URL=https://staging.orvyn.virphoneusa.com
DOMAIN=orvyn.virphoneusa.com
STAGING_DOMAIN=staging.orvyn.virphoneusa.com
EOF
  # Copy model keys from production .env without overwriting staging identity.
  if [[ -f .env ]]; then
    grep -E '^(CHEAPER_INFERENCE_|MODEL_API_KEY|OPENAI_|ORION_MODEL_ID|ASTRA_MODEL_ID|DEEPSEEK_|GEMINI_|FIREWORKS_)' .env >> .env.staging || true
  fi
  echo 'Created isolated .env.staging'
fi
# Production Caddy must know the staging hostname. Bring staging up first
# so backend-staging is resolvable on orvyn_default before Caddy reloads.
if ! grep -q STAGING_DOMAIN .env; then
  echo 'STAGING_DOMAIN=staging.orvyn.virphoneusa.com' >> .env
fi
docker compose -p orvyn-staging -f infrastructure/ovh/compose.staging.yml --env-file .env.staging up -d --build
docker compose -p orvyn-staging -f infrastructure/ovh/compose.staging.yml ps
docker compose \\
  -f docker-compose.yml \\
  -f infrastructure/ovh/compose.prod.yml \\
  -f infrastructure/ovh/compose.control-plane.yml \\
  restart caddy
docker compose \\
  -f docker-compose.yml \\
  -f infrastructure/ovh/compose.prod.yml \\
  -f infrastructure/ovh/compose.control-plane.yml \\
  ps caddy backend
"

echo "Waiting for $STAGING_HEALTH"
ok=0
for _ in $(seq 1 50); do
  if curl -fsS -m 8 "$STAGING_HEALTH" | grep -q '"status":"ok"'; then
    ok=1
    break
  fi
  sleep 3
done
if [[ "$ok" -ne 1 ]]; then
  echo "Staging health check failed after deploy (DNS/TLS may still be pending)" >&2
  curl -sS -m 8 "$STAGING_HEALTH" || true
  echo
  exit 1
fi
echo "Staging healthy: $STAGING_HEALTH"
curl -sS -m 8 "$STAGING_HEALTH"
echo
curl -sS -m 12 "${STAGING_HEALTH}/detailed" || true
echo
