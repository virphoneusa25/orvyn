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

"${SSH[@]}" "$HOST" "mkdir -p '$REMOTE/apps/backend' '$REMOTE/apps/web' '$REMOTE/apps/worker' '$REMOTE/packages' '$REMOTE/infrastructure' '$REMOTE/scripts' '$REMOTE/resources'"

rsync -az --delete -e "$RSH" \
  --exclude node_modules/ --exclude dist/ --exclude '*.log' \
  "$ROOT/apps/backend/" "$HOST:$REMOTE/apps/backend/"

rsync -az --delete -e "$RSH" \
  --exclude node_modules/ --exclude dist/ --exclude '*.log' \
  "$ROOT/apps/web/" "$HOST:$REMOTE/apps/web/"

rsync -az --delete -e "$RSH" \
  --exclude node_modules/ --exclude dist/ --exclude '*.log' \
  "$ROOT/apps/worker/" "$HOST:$REMOTE/apps/worker/"

rsync -az --delete -e "$RSH" \
  --exclude node_modules/ --exclude dist/ \
  "$ROOT/packages/" "$HOST:$REMOTE/packages/"

rsync -az --delete -e "$RSH" \
  "$ROOT/infrastructure/" "$HOST:$REMOTE/infrastructure/"

# The worker image bakes in the OpenShell acceptance suite (apps/worker/Dockerfile
# copies it from scripts/acceptance), so it must be in the build context.
"${SSH[@]}" "$HOST" "mkdir -p '$REMOTE/scripts/acceptance'"
rsync -az -e "$RSH" \
  "$ROOT/scripts/acceptance/openshell-sandbox.mjs" "$HOST:$REMOTE/scripts/acceptance/"

# The backend image copies resources/skills. The OVH build context is this
# partial sync, not a git checkout, so the directory has to be sent explicitly.
rsync -az --delete -e "$RSH" \
  "$ROOT/resources/" "$HOST:$REMOTE/resources/"

rsync -az -e "$RSH" \
  "$ROOT/docker-compose.yml" \
  "$ROOT/package.json" \
  "$ROOT/package-lock.json" \
  "$ROOT/.dockerignore" \
  "$ROOT/.env.example" \
  "$HOST:$REMOTE/"

# Secrets from the deploy environment (GitHub secrets) go into the server's
# .env, which deploys otherwise never touch. Values travel on stdin, never on
# a command line. Unset ones are skipped (the server keeps what it has).
#   model providers: NEBIUS_API_KEY, FIREWORKS_API_KEY, HUGGINGFACE_API_KEY
#   account email (verification links): SMTP_*
#   sign-in and billing (added when the apps exist): GOOGLE_*, GITHUB_*, STRIPE_*
# Repository variables (not secrets) arrive as one JSON object; only these names are taken.
# One combined secret per provider (GOOGLE_OAUTH, ORVYN_GH_SECRET) is split
# into the ID/secret pair the server reads.
while IFS='=' read -r k v; do [[ -n "$k" ]] && export "$k=$v"; done < <(python3 "$ROOT/scripts/split-oauth-secrets.py")
if [[ -n "${DEPLOY_VARS:-}" ]]; then
  while IFS='=' read -r k v; do [[ -n "$k" ]] && export "$k=$v"; done < <(python3 -c '
import json, os, re
d = json.loads(os.environ.get("DEPLOY_VARS") or "{}")
for k, v in d.items():
    if re.match(r"^(STRIPE_PRICE_[A-Z0-9_]+|ORVYN_PUBLIC_ORIGIN|ORVYN_APP_HOST|ORVYN_ADMIN_HOST|ORVYN_SUPER_ADMIN_EMAILS|ORVYN_TERMS_URL|ORVYN_PRIVACY_URL|FIREWORKS_VISION_MODELS|HUGGINGFACE_BASE_URL|HUGGINGFACE_MODELS|HUGGINGFACE_ROUTING_ENABLED|BACKUP_S3_URI|BACKUP_S3_ENDPOINT|AWS_DEFAULT_REGION)$", k) and "\n" not in str(v):
        print(f"{k}={v}")
')
fi
# Say what this deploy can send (names only, never values).
for n in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET SMTP_HOST SMTP_USER SMTP_PASS SMTP_FROM; do
  if [[ -n "${!n:-}" ]]; then echo "Secret present: $n"; else echo "::warning title=Not set::$n is not set for this deploy — the server keeps its previous value (none on a fresh server)."; fi
done
PRICE_NAMES=""
# ANNUAL is the canonical repository-variable suffix; YEARLY kept so an older
# variable set still reaches the server's .env.
for plan in STARTER PRO POWER BUSINESS TEAM; do PRICE_NAMES="$PRICE_NAMES STRIPE_PRICE_${plan}_MONTHLY STRIPE_PRICE_${plan}_ANNUAL STRIPE_PRICE_${plan}_YEARLY"; done
for pack in 10K 25K 50K 100K 250K 500K; do PRICE_NAMES="$PRICE_NAMES STRIPE_PRICE_PACK_${pack}"; done
  for name in ORVYN_PROVIDER_RATES_JSON ORVYN_IMAGE_SETTLEMENT_BUDGET_USD MODEL_API_KEY CHEAPER_INFERENCE_API_KEY MISTRAL_API_KEY OPENROUTER_API_KEY GEMINI_API_KEY NEBIUS_API_KEY DEEPSEEK_API_KEY DEEPSEEK_EXECUTOR_OVERRIDE_ENABLED DEEPSEEK_BASE_URL DEEPSEEK_CODE_MODEL DEEPSEEK_PRO_MODEL FIREWORKS_API_KEY FIREWORKS_MODELS FIREWORKS_BASE_URL FIREWORKS_VISION_MODELS HUGGINGFACE_API_KEY HF_TOKEN HUGGINGFACE_BASE_URL HUGGINGFACE_MODELS HUGGINGFACE_ROUTING_ENABLED SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER SMTP_PASS SMTP_FROM \
  GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET \
  ORVYN_PUBLIC_ORIGIN ORVYN_APP_HOST ORVYN_ADMIN_HOST ORVYN_SUPER_ADMIN_EMAILS ORVYN_TERMS_URL ORVYN_PRIVACY_URL $PRICE_NAMES; do
  value="${!name:-}"
  [[ -n "$value" ]] || continue
  printf '%s' "$value" | "${SSH[@]}" "$HOST" "set -euo pipefail
cd '$REMOTE'
touch .env && chmod 600 .env
value=\$(cat)
{ grep -v '^$name=' .env || true; printf '%s=%s\\n' '$name' \"\$value\"; } > .env.tmp
mv .env.tmp .env && chmod 600 .env"
  echo "Set $name in the server .env"
done

# Backup settings live in their own root-only file, read by the backup timer.
for name in BACKUP_PASSPHRASE BACKUP_S3_URI BACKUP_S3_ENDPOINT AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION; do
  value="${!name:-}"
  [[ -n "$value" ]] || continue
  printf '%s' "$value" | "${SSH[@]}" "$HOST" "set -euo pipefail
cd '$REMOTE'
touch .backup.env && chmod 600 .backup.env
value=\$(cat)
{ grep -v '^$name=' .backup.env || true; printf '%s=%s\\n' '$name' \"\$value\"; } > .backup.env.tmp
mv .backup.env.tmp .backup.env && chmod 600 .backup.env"
done

# Hourly backups, a weekly restore drill, host disk retention and capacity
# alarms (idempotent install).
"${SSH[@]}" "$HOST" "set -euo pipefail
cd '$REMOTE'
chmod +x infrastructure/ovh/backup.sh infrastructure/ovh/restore-drill.sh infrastructure/ovh/host-maintenance.sh infrastructure/ovh/host-alerts.sh
sudo install -m 644 infrastructure/ovh/orvyn-backup.service infrastructure/ovh/orvyn-backup.timer \
  infrastructure/ovh/orvyn-restore-drill.service infrastructure/ovh/orvyn-restore-drill.timer \
  infrastructure/ovh/orvyn-host-maintenance.service infrastructure/ovh/orvyn-host-maintenance.timer \
  infrastructure/ovh/orvyn-host-alerts.service infrastructure/ovh/orvyn-host-alerts.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now orvyn-backup.timer orvyn-restore-drill.timer orvyn-host-maintenance.timer orvyn-host-alerts.timer
" || echo "warning: could not install the backup/retention timers (check sudo on the host)" >&2

# Never rebuild over customer data without a verified backup first.
if [[ "${ORVYN_SKIP_PREDEPLOY_BACKUP:-}" != "1" ]]; then
  echo "Pre-deploy backup on $HOST"
  if ! "${SSH[@]}" "$HOST" "set -euo pipefail
cd '$REMOTE'
if docker compose -f docker-compose.yml -f infrastructure/ovh/compose.prod.yml ps --services --status running | grep -qx backend; then
  sudo -n bash -c 'set -euo pipefail; set -a; if [ -f .backup.env ]; then . ./.backup.env; fi; set +a; exec infrastructure/ovh/backup.sh --tag predeploy'
else
  echo 'backend not running: nothing to back up'
fi"; then
    echo "Pre-deploy backup FAILED — not deploying. Fix the backup, or set ORVYN_SKIP_PREDEPLOY_BACKUP=1 to deploy anyway." >&2
    exit 1
  fi
fi

echo "Rebuilding on $HOST (Caddy check, optional OpenShell, backend + worker)"
"${SSH[@]}" "$HOST" "cd '$REMOTE' && bash infrastructure/ovh/remote-deploy.sh"

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

# The primary API can be healthy while a portal hostname is misrouted. Verify
# both public shells, their same-origin API, and the provider-status endpoint.
for surface in app admin; do
  if [[ "$surface" == app ]]; then host="${ORVYN_APP_HOST:-app.kernelailabs.com}"; else host="${ORVYN_ADMIN_HOST:-admin.kernelailabs.com}"; fi
  origin="https://$host"
  curl -fsS -m 12 "$origin/" | grep -Fq "name=\"orvyn-surface\" content=\"$surface\"" || { echo "$origin is not serving the $surface portal" >&2; exit 1; }
  curl -fsS -m 12 "$origin/api/v1/health" | grep -q '"status":"ok"' || { echo "$origin API health failed" >&2; exit 1; }
  curl -fsS -m 12 "$origin/api/v1/onboarding/providers" | grep -q '"email":' || { echo "$origin auth-provider status failed" >&2; exit 1; }
  echo "Verified $origin: $surface portal, API, auth-provider status"
done

# OpenShell is optional for customer traffic, so a failed upgrade must not
# take the portals down. It is still a failed upgrade: surface that only after
# the core service and both portals have been proved healthy.
if ! "${SSH[@]}" "$HOST" "cd '$REMOTE'; ! grep -qx 'OPENSHELL_ENABLED=true' .env 2>/dev/null || grep -qx 'OPENSHELL_ACCEPTANCE_PASSED=true' .env"; then
  echo "::warning title=OpenShell locked::Acceptance did not pass on this deploy. Core portals are healthy; OpenShell stays disabled for all organizations until the acceptance run passes. Report: /opt/orvyn/workspaces/_acceptance/report.json" >&2
fi

echo "Building orvyn-desktop image on $HOST"
if ! "${SSH[@]}" "$HOST" "cd '$REMOTE/infrastructure/desktop' && docker build -t orvyn-desktop:latest ."; then
  echo "Desktop image build failed. Existing sessions keep the previous orvyn-desktop image until the next successful build." >&2
fi
