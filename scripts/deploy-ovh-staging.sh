#!/usr/bin/env bash
# Deploy the production candidate to the existing isolated staging stack.
# Sources live separately from production; existing staging secrets and volumes survive.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${OVH_HOST:-ubuntu@40.160.11.123}"
KEY="${OVH_SSH_KEY:-$HOME/.ssh/github_virphone}"
REMOTE="${OVH_REMOTE_DIR:-/home/ubuntu/orvyn-staging-release}"
PRODUCTION="/home/ubuntu/orvyn"
STAGING_HEALTH="${STAGING_HEALTH_URL:-https://staging.orvyn.virphoneusa.com/api/v1/health}"
[[ "$REMOTE" == /home/ubuntu/orvyn-staging-release ]] || { echo "Refusing an unverified staging source path" >&2; exit 1; }
[[ -f "$KEY" ]] || { echo "OVH SSH key missing" >&2; exit 1; }
SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
RSH="${SSH[*]}"
COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
printf '{"commit":"%s","builtAt":"%s"}\n' "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$ROOT/apps/backend/build-info.json"
"${SSH[@]}" "$HOST" "set -eu; mkdir -p '$REMOTE'; chmod 700 '$REMOTE'; if [ ! -f '$REMOTE/.env.staging' ]; then test -f '$PRODUCTION/.env.staging'; cp '$PRODUCTION/.env.staging' '$REMOTE/.env.staging'; chmod 600 '$REMOTE/.env.staging'; fi"
for folder in apps/backend apps/web apps/worker packages infrastructure resources scripts; do
  "${SSH[@]}" "$HOST" "mkdir -p '$REMOTE/$folder'"
  rsync -az --delete -e "$RSH" --exclude node_modules/ --exclude dist/ --exclude '*.log' --exclude .env --exclude .env.staging "$ROOT/$folder/" "$HOST:$REMOTE/$folder/"
done
rsync -az -e "$RSH" "$ROOT/docker-compose.yml" "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/.dockerignore" "$HOST:$REMOTE/"
# Only configured HF settings change. Identity, database passwords and all other
# staging environment values are preserved. Secrets travel over SSH stdin.
for name in HUGGINGFACE_API_KEY HF_TOKEN HUGGINGFACE_BASE_URL HUGGINGFACE_MODELS HUGGINGFACE_ROUTING_ENABLED NEBIUS_API_KEY DEEPSEEK_API_KEY DEEPSEEK_EXECUTOR_OVERRIDE_ENABLED DEEPSEEK_BASE_URL DEEPSEEK_CODE_MODEL DEEPSEEK_PRO_MODEL FIREWORKS_API_KEY FIREWORKS_MODELS FIREWORKS_BASE_URL; do
  value="${!name:-}"
  [[ -n "$value" ]] || continue
  printf '%s' "$value" | "${SSH[@]}" "$HOST" "set -eu; cd '$REMOTE'; value=\$(cat); { grep -v '^$name=' .env.staging || true; printf '%s=%s\\n' '$name' \"\$value\"; } > .env.staging.tmp; chmod 600 .env.staging.tmp; mv .env.staging.tmp .env.staging"
done
"${SSH[@]}" "$HOST" "set -eu; cd '$REMOTE'; current=\$(docker inspect backend-staging --format '{{.Image}}'); docker image tag \"\$current\" orvyn-staging-backend-staging:rollback-before-shared-hf; docker compose -p orvyn-staging -f infrastructure/ovh/compose.staging.yml --env-file .env.staging up -d --build"
for _ in $(seq 1 40); do
  if curl -fsS -m 8 "$STAGING_HEALTH" | grep -q "\"commit\":\"$COMMIT\""; then
    curl -fsS -m 8 "$STAGING_HEALTH"; echo
    cat "$ROOT/scripts/acceptance/hf-routing-preflight.cjs" | "${SSH[@]}" "$HOST" "docker exec -i backend-staging node"
    if [[ -n "${DEEPSEEK_API_KEY:-}" ]]; then
      cat "$ROOT/scripts/acceptance/hf-routing-preflight.cjs" | "${SSH[@]}" "$HOST" "docker exec -i backend-staging node - /app/dist deepseek"
    fi
    echo "Staging commit and HF coding/tool provider evidence verified"
    exit 0
  fi
  sleep 3
done
echo "Staging did not report the candidate commit; production was not deployed" >&2
exit 1
