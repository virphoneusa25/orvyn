#!/usr/bin/env bash
# Deploy the production candidate to the existing isolated staging stack.
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
