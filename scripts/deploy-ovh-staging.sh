#!/usr/bin/env bash
# Deploy immutable CI-built images to isolated OVH staging; application images
# are never built on the constrained host.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${OVH_HOST:-ubuntu@40.160.11.123}"
KEY="${OVH_SSH_KEY:-$HOME/.ssh/github_virphone}"
REMOTE="${OVH_REMOTE_DIR:-/home/ubuntu/orvyn-staging-release}"
STAGING_HEALTH="${STAGING_HEALTH_URL:-https://staging.orvyn.virphoneusa.com/api/v1/health}"
COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
BACKEND_IMAGE="${ORVYN_BACKEND_IMAGE:-}"
WORKER_IMAGE="${ORVYN_WORKER_IMAGE:-}"
GHCR_USERNAME="${GHCR_USERNAME:-}"
GHCR_TOKEN="${GHCR_TOKEN:-}"
[[ "$REMOTE" == /home/ubuntu/orvyn-staging-release ]] || { echo "Refusing an unverified staging source path" >&2; exit 1; }
[[ -f "$KEY" ]] || { echo "OVH SSH key missing" >&2; exit 1; }
[[ "$BACKEND_IMAGE" =~ ^ghcr\.io/virphoneusa25/orvyn-backend@sha256:[0-9a-f]{64}$ ]] || { echo "Missing exact backend GHCR digest" >&2; exit 1; }
[[ "$WORKER_IMAGE" =~ ^ghcr\.io/virphoneusa25/orvyn-worker@sha256:[0-9a-f]{64}$ ]] || { echo "Missing exact worker GHCR digest" >&2; exit 1; }
[[ -n "$GHCR_USERNAME" && -n "$GHCR_TOKEN" ]] || { echo "GitHub Actions staging registry credentials are missing" >&2; exit 1; }
SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
RSH="${SSH[*]}"
AUTH_DIR="/tmp/orvyn-ghcr-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}"

"${SSH[@]}" "$HOST" "set -eu; mkdir -p '$REMOTE/infrastructure/ovh'; chmod 700 '$REMOTE'; test -f '$REMOTE/.env.staging' || { echo 'Isolated staging configuration is missing' >&2; exit 1; }; chmod 600 '$REMOTE/.env.staging'"
rsync -az -e "$RSH" "$ROOT/infrastructure/ovh/compose.staging.yml" "$HOST:$REMOTE/infrastructure/ovh/compose.staging.yml"

# Refresh only configured provider settings. Values are sent on SSH stdin so
# credentials are not embedded in the remote command line or image layers.
for name in ORVYN_PROVIDER_RATES_JSON ORVYN_IMAGE_SETTLEMENT_BUDGET_USD MODEL_API_KEY CHEAPER_INFERENCE_API_KEY MISTRAL_API_KEY OPENROUTER_API_KEY GEMINI_API_KEY HUGGINGFACE_API_KEY HF_TOKEN HUGGINGFACE_BASE_URL HUGGINGFACE_MODELS HUGGINGFACE_ROUTING_ENABLED NEBIUS_API_KEY DEEPSEEK_API_KEY DEEPSEEK_EXECUTOR_OVERRIDE_ENABLED DEEPSEEK_BASE_URL DEEPSEEK_CODE_MODEL DEEPSEEK_PRO_MODEL FIREWORKS_API_KEY FIREWORKS_MODELS FIREWORKS_BASE_URL; do
  value="${!name:-}"
  [[ -n "$value" ]] || continue
  printf '%s' "$value" | "${SSH[@]}" "$HOST" "set -eu; cd '$REMOTE'; value=\$(cat); { grep -v '^$name=' .env.staging || true; printf '%s=%s\\n' '$name' \"\$value\"; } > .env.staging.tmp; chmod 600 .env.staging.tmp; mv .env.staging.tmp .env.staging"
done

# Temporary, run-scoped Docker credential storage is removed on success and
# failure. The token has packages:read scope only in the deploy job.
if ! printf '%s' "$GHCR_TOKEN" | "${SSH[@]}" "$HOST" "set -eu; mkdir -m 700 -p '$AUTH_DIR'; if ! DOCKER_CONFIG='$AUTH_DIR' docker login ghcr.io --username '$GHCR_USERNAME' --password-stdin >/dev/null; then rm -rf -- '$AUTH_DIR'; exit 1; fi"; then
  echo "Staging host could not authenticate to private GHCR packages" >&2
  exit 1
fi
cleanup_registry_auth() { "${SSH[@]}" "$HOST" "rm -rf -- '$AUTH_DIR'" >/dev/null 2>&1 || true; }
trap cleanup_registry_auth EXIT
if ! { cat "$ROOT/scripts/deploy-ovh-staging-remote.sh"; } | "${SSH[@]}" "$HOST" "DOCKER_CONFIG='$AUTH_DIR' bash -s -- '$REMOTE' '$COMMIT' '$BACKEND_IMAGE' '$WORKER_IMAGE' '$AUTH_DIR'"; then
  echo "Immutable image deployment failed; prior images and persistent services were preserved" >&2
  exit 1
fi

rollback_backend="orvyn-staging-backend:rollback-before-$COMMIT"
rollback_worker="orvyn-staging-worker:rollback-before-$COMMIT"
rollback() {
  echo "Staging release gate failed; restoring the exact previous backend and worker image IDs" >&2
  "${SSH[@]}" "$HOST" "set -eu; cd '$REMOTE'; b=\$(docker image inspect --format '{{.Id}}' '$rollback_backend'); w=\$(docker image inspect --format '{{.Id}}' '$rollback_worker'); export ORVYN_BACKEND_IMAGE='$rollback_backend' ORVYN_WORKER_IMAGE='$rollback_worker'; docker compose -p orvyn-staging -f infrastructure/ovh/compose.staging.yml --env-file .env.staging up -d --no-build --no-deps backend-staging worker-staging; for n in \$(seq 1 40); do bh=\$(docker inspect --format '{{.State.Health.Status}}' backend-staging); bi=\$(docker inspect --format '{{.Image}}' backend-staging); wi=\$(docker inspect --format '{{.Image}}' worker-staging); if [ \"\$bh\" = healthy ] && [ \"\$bi\" = \"\$b\" ] && [ \"\$wi\" = \"\$w\" ]; then echo 'Exact previous image IDs restored and backend health is healthy'; exit 0; fi; sleep 5; done; echo 'Rollback image or health verification failed' >&2; exit 1"
}
for _ in $(seq 1 40); do
  health="$(curl -fsS -m 8 "$STAGING_HEALTH" 2>/dev/null || true)"
  if jq -e --arg commit "$COMMIT" '.commit == $commit and .environment == "staging"' <<<"$health" >/dev/null 2>&1; then
    printf '%s\n' "$health"
    break
  fi
  sleep 3
done
if ! jq -e --arg commit "$COMMIT" '.commit == $commit and .environment == "staging"' <<<"${health:-}" >/dev/null 2>&1; then rollback || { echo "Rollback health verification also failed" >&2; exit 1; }; echo "Staging health did not report exact commit $COMMIT" >&2; exit 1; fi

if [[ "${ORVYN_AUTHORIZE_HF_PAID_PROBE:-false}" == "true" ]]; then
  echo "Running the separately authorized Hugging Face capability probe (maximum $0.01)"
  cat "$ROOT/scripts/acceptance/verify-hf-capabilities.cjs" | "${SSH[@]}" "$HOST" "docker exec -i backend-staging node - --authorize-paid-probe --model hf:moonshotai/Kimi-K2.7-Code:deepinfra --max-usd 0.01" || { rollback || { echo "Rollback health verification also failed" >&2; exit 1; }; exit 1; }
fi
if ! cat "$ROOT/scripts/acceptance/hf-routing-preflight.cjs" | "${SSH[@]}" "$HOST" "docker exec -i backend-staging node - /app/dist --saved-evidence-only"; then
  rollback || { echo "Rollback health verification also failed" >&2; exit 1; }
  exit 1
fi
echo "Optional DeepSeek live smoke skipped (separate authorization required)"
if ! cat "$ROOT/scripts/acceptance/provider-billing-preflight.cjs" | "${SSH[@]}" "$HOST" "docker exec -i backend-staging node"; then rollback || { echo "Rollback health verification also failed" >&2; exit 1; }; exit 1; fi
"${SSH[@]}" "$HOST" "rm -rf -- '$AUTH_DIR'"
trap - EXIT
echo "Staging commit $COMMIT passed immutable image, health, saved-evidence and billing preflight"
