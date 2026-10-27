#!/usr/bin/env bash
# Deploy the production candidate to the existing isolated staging stack.
# Staging release checks reuse persisted HF verification without automatic paid probes.
# Sources live separately from production; existing staging secrets and volumes survive.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${OVH_HOST:-ubuntu@40.160.11.123}"
KEY="${OVH_SSH_KEY:-$HOME/.ssh/github_virphone}"
REMOTE="${OVH_REMOTE_DIR:-/home/ubuntu/orvyn-staging-release}"
STAGING_HEALTH="${STAGING_HEALTH_URL:-https://staging.orvyn.virphoneusa.com/api/v1/health}"
[[ "$REMOTE" == /home/ubuntu/orvyn-staging-release ]] || { echo "Refusing an unverified staging source path" >&2; exit 1; }
[[ -f "$KEY" ]] || { echo "OVH SSH key missing" >&2; exit 1; }
SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
RSH="${SSH[*]}"
COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
printf '{"commit":"%s","builtAt":"%s"}\n' "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$ROOT/apps/backend/build-info.json"
"${SSH[@]}" "$HOST" "set -eu; mkdir -p '$REMOTE'; chmod 700 '$REMOTE'; test -f '$REMOTE/.env.staging' || { echo 'Isolated staging configuration is missing; refusing to read production configuration' >&2; exit 1; }; chmod 600 '$REMOTE/.env.staging'"
for folder in apps/backend apps/web apps/worker packages infrastructure resources scripts; do
  "${SSH[@]}" "$HOST" "mkdir -p '$REMOTE/$folder'"
  rsync -az --delete -e "$RSH" --exclude node_modules/ --exclude dist/ --exclude '*.log' --exclude .env --exclude .env.staging "$ROOT/$folder/" "$HOST:$REMOTE/$folder/"
done
rsync -az -e "$RSH" "$ROOT/docker-compose.yml" "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/.dockerignore" "$HOST:$REMOTE/"
# Only configured HF settings change. Identity, database passwords and all other
# staging environment values are preserved. Secrets travel over SSH stdin.
for name in ORVYN_PROVIDER_RATES_JSON ORVYN_IMAGE_SETTLEMENT_BUDGET_USD MODEL_API_KEY CHEAPER_INFERENCE_API_KEY MISTRAL_API_KEY OPENROUTER_API_KEY GEMINI_API_KEY HUGGINGFACE_API_KEY HF_TOKEN HUGGINGFACE_BASE_URL HUGGINGFACE_MODELS HUGGINGFACE_ROUTING_ENABLED NEBIUS_API_KEY DEEPSEEK_API_KEY DEEPSEEK_EXECUTOR_OVERRIDE_ENABLED DEEPSEEK_BASE_URL DEEPSEEK_CODE_MODEL DEEPSEEK_PRO_MODEL FIREWORKS_API_KEY FIREWORKS_MODELS FIREWORKS_BASE_URL; do
  value="${!name:-}"
  [[ -n "$value" ]] || continue
  printf '%s' "$value" | "${SSH[@]}" "$HOST" "set -eu; cd '$REMOTE'; value=\$(cat); { grep -v '^$name=' .env.staging || true; printf '%s=%s\\n' '$name' \"\$value\"; } > .env.staging.tmp; chmod 600 .env.staging.tmp; mv .env.staging.tmp .env.staging"
done
# Verify the isolated staging host has room for Chromium and image layers. If needed,
# reclaim only unused Docker builder cache older than 24 hours; never touch images,
# containers, volumes, databases, or rollback references.
MIN_STAGING_FREE_KB=10485760 # 10 GiB
STAGING_FREE_KB="$("${SSH[@]}" "$HOST" "df -Pk '$REMOTE'" | awk 'NR==2 {print $4}')"
if [[ ! "$STAGING_FREE_KB" =~ ^[0-9]+$ ]] || (( STAGING_FREE_KB < MIN_STAGING_FREE_KB )); then
  echo "Staging disk is below the build threshold; inspecting disk, inode and Docker usage before safe cache cleanup"
  "${SSH[@]}" "$HOST" "df -h '$REMOTE'; df -i '$REMOTE'; docker system df -v"
  "${SSH[@]}" "$HOST" "docker buildx du --verbose; docker buildx prune --filter 'until=24h' --force"
  STAGING_FREE_KB="$("${SSH[@]}" "$HOST" "df -Pk '$REMOTE'" | awk 'NR==2 {print $4}')"
  echo "Staging disk after unused builder-cache cleanup: ${STAGING_FREE_KB:-unknown} KB available"
  "${SSH[@]}" "$HOST" "df -h '$REMOTE'; df -i '$REMOTE'"
  if [[ ! "$STAGING_FREE_KB" =~ ^[0-9]+$ ]] || (( STAGING_FREE_KB < MIN_STAGING_FREE_KB )); then
    echo "ERROR: Isolated staging still lacks required disk space (available KB: ${STAGING_FREE_KB:-unknown}; required KB: $MIN_STAGING_FREE_KB). Preserve volumes, rollback images and running containers; expand disk before retry." >&2
    exit 1
  fi
fi
echo "Staging disk preflight passed: $STAGING_FREE_KB KB available"
ROLLBACK_REF="orvyn-staging-backend-staging:rollback-before-${COMMIT}"
"${SSH[@]}" "$HOST" "set -eu; cd '$REMOTE'; current=\$(docker inspect backend-staging --format '{{.Image}}'); if docker image inspect '$ROLLBACK_REF' >/dev/null 2>&1; then printf 'Preserving existing staging rollback image: %s\\n' '$ROLLBACK_REF'; else docker image tag \"\$current\" '$ROLLBACK_REF'; fi; printf 'Staging rollback image: %s (image ID %s)\\n' '$ROLLBACK_REF' \"\$current\"; docker compose -p orvyn-staging -f infrastructure/ovh/compose.staging.yml --env-file .env.staging up -d --build"
for _ in $(seq 1 40); do
  if curl -fsS -m 8 "$STAGING_HEALTH" | grep -q "\"commit\":\"$COMMIT\""; then
    curl -fsS -m 8 "$STAGING_HEALTH"; echo
    if [[ "${ORVYN_AUTHORIZE_HF_PAID_PROBE:-false}" == "true" ]]; then
      echo "Running the explicitly authorized single Hugging Face capability probe (maximum $0.01)"
      cat "$ROOT/scripts/acceptance/verify-hf-capabilities.cjs" | "${SSH[@]}" "$HOST" "docker exec -i backend-staging node - --authorize-paid-probe --model hf:moonshotai/Kimi-K2.7-Code:deepinfra --max-usd 0.01"
    fi
    cat "$ROOT/scripts/acceptance/hf-routing-preflight.cjs" | "${SSH[@]}" "$HOST" "docker exec -i backend-staging node - /app/dist --saved-evidence-only"
    # Do not implicitly run a second, billable live model smoke test.
    # Hugging Face's persisted verification is the required staging gate above.
    # DeepSeek live verification requires a separate explicit operator authorization
    # and budget policy; merely having a configured key is not consent to spend.
    echo "Optional DeepSeek live smoke skipped (separate authorization required)"
    echo "Staging commit and HF coding/tool provider evidence verified"
    cat "$ROOT/scripts/acceptance/provider-billing-preflight.cjs" | "${SSH[@]}" "$HOST" "docker exec -i backend-staging node"
    exit 0
  fi
  sleep 3
done
echo "Staging did not report the candidate commit; production was not deployed" >&2
exit 1
