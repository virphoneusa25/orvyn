#!/usr/bin/env bash
# infrastructure/ovh/remote-deploy.sh — runs ON the server (called by
# scripts/deploy-ovh.sh after the source sync). Kept as a real file instead of
# a quoted SSH string so it can be linted and has no escaping traps.
#
# Order matters: the core services (backend, worker, Caddy) must come up even
# when the optional OpenShell runtime is broken. OpenShell only joins the
# deploy when its preparation succeeded, and customers only reach it after the
# live acceptance gate passed (OPENSHELL_ACCEPTANCE_PASSED=true) AND their
# organization is on the canary.
set -euo pipefail
cd "$(dirname "$0")/../.."

BASE=(-f docker-compose.yml -f infrastructure/ovh/compose.prod.yml
  -f infrastructure/ovh/compose.control-plane.yml -f infrastructure/ovh/compose.worker.yml)

set_env() { # set_env NAME VALUE — rewrite one line of .env, keep mode 600
  touch .env
  { grep -v "^$1=" .env || true; echo "$1=$2"; } > .env.tmp
  mv .env.tmp .env
  chmod 600 .env
}
set_default_env() { # keep an operator override, otherwise install the production default
  grep -q "^$1=" .env 2>/dev/null || set_env "$1" "$2"
}
warn() { echo "::warning title=OpenShell::$*"; echo "WARNING: $*" >&2; }

# Qwen3 Embedding 8B is the production memory/RAG lane when Nebius is present.
# Its 4096-dimensional vector space is stored separately and rebuilt by the
# index service; an explicit operator setting always wins.
if grep -q '^NEBIUS_API_KEY=.' .env 2>/dev/null; then
  set_default_env ORVYN_EMBED_MODEL nebius:Qwen/Qwen3-Embedding-8B
  set_default_env ORVYN_EMBED_DIMS 4096
fi

echo "Validating Caddy configuration"
docker compose "${BASE[@]}" run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

OVERLAY=()
if grep -qx 'OPENSHELL_ENABLED=true' .env 2>/dev/null; then
  # Never carry a pass bit across a new build: only this deploy's acceptance
  # run may set it again.
  set_env OPENSHELL_ACCEPTANCE_PASSED false
  if bash infrastructure/openshell/prepare.sh; then
    OVERLAY=(-f infrastructure/ovh/compose.openshell.yml)
    echo "OpenShell overlay: enabled"
  else
    warn "OpenShell preparation failed; deploying without it. Every mission keeps running on Docker."
  fi
else
  echo "OpenShell overlay: disabled (OPENSHELL_ENABLED is not true in .env)"
fi
COMPOSE=(docker compose "${BASE[@]}" "${OVERLAY[@]}")

echo "Rebuilding backend + worker"
"${COMPOSE[@]}" up -d --build --no-deps backend worker
# Caddy: pick up new site blocks (app/admin hosts) without dropping connections.
"${COMPOSE[@]}" up -d --no-deps caddy
"${COMPOSE[@]}" exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile || echo "caddy reload skipped"
"${COMPOSE[@]}" ps

if [ "${#OVERLAY[@]}" -gt 0 ]; then
  echo "Running the OpenShell acceptance gate"
  if bash infrastructure/openshell/accept.sh; then
    set_env OPENSHELL_ACCEPTANCE_PASSED true
    # Recreate the backend so it reads the new pass bit.
    "${COMPOSE[@]}" up -d --no-deps backend
    echo "OpenShell acceptance passed; canary organizations may now use it"
  else
    warn "OpenShell acceptance failed; it stays locked (OPENSHELL_ACCEPTANCE_PASSED=false). Report: /opt/orvyn/workspaces/_acceptance/report.json"
  fi
fi
