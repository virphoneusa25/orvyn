#!/usr/bin/env bash
# Production configuration gate for the ORVYN OVH deployment.
# Checks names only; never prints secret values.
set -euo pipefail

missing=0

require() {
  local name="$1"
  if [[ -n "${!name:-}" ]]; then
    echo "Config present: $name"
  else
    echo "::error title=Missing production config::$name is not set."
    missing=1
  fi
}

require_one_of() {
  local label="$1"; shift
  local name
  for name in "$@"; do
    if [[ -n "${!name:-}" ]]; then
      echo "Config present: $label ($name)"
      return 0
    fi
  done
  echo "::error title=Missing production config::$label is not set (accepted names: $*)."
  missing=1
}

# Public origin used by OAuth/email/Stripe return URLs.
require ORVYN_PUBLIC_ORIGIN

# OAuth. IDs may be repository variables; secrets stay in Actions secrets.
require GOOGLE_CLIENT_ID
require GOOGLE_CLIENT_SECRET
require GITHUB_CLIENT_ID
require GITHUB_CLIENT_SECRET

# SMTP / verification and password-reset email.
require SMTP_HOST
require SMTP_PORT
require SMTP_SECURE
require SMTP_USER
require SMTP_PASS
require SMTP_FROM

case "${SMTP_PORT:-}" in
  465)
    [[ "${SMTP_SECURE:-}" == "true" ]] || {
      echo "::error title=SMTP configuration::SMTP_SECURE must be true when SMTP_PORT=465."
      missing=1
    }
    ;;
  587)
    [[ "${SMTP_SECURE:-}" == "false" ]] || {
      echo "::error title=SMTP configuration::SMTP_SECURE must be false when SMTP_PORT=587."
      missing=1
    }
    ;;
esac

# Stripe sales configuration.
require STRIPE_SECRET_KEY
require STRIPE_WEBHOOK_SECRET
for plan in STARTER PRO POWER BUSINESS TEAM; do
  require "STRIPE_PRICE_${plan}_MONTHLY"
  require "STRIPE_PRICE_${plan}_ANNUAL"
done
for pack in 10K 25K 50K 100K 250K 500K; do
  require "STRIPE_PRICE_PACK_${pack}"
done

# Off-host encrypted backups.
require BACKUP_S3_URI
require BACKUP_PASSPHRASE
require BACKUP_S3_ACCESS_KEY_ID
require BACKUP_S3_SECRET_ACCESS_KEY
# BACKUP_S3_ENDPOINT is optional for AWS S3, required only for non-AWS S3-compatible storage.

if [[ "$missing" -ne 0 ]]; then
  echo "::error title=Production readiness gate::Required ORVYN production configuration is incomplete. Deployment stopped before touching OVH."
  exit 1
fi

echo "ORVYN production configuration gate passed."
