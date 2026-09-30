#!/usr/bin/env bash
# infrastructure/openshell/prepare.sh — run by infrastructure/ovh/remote-deploy.sh
# on every deploy where the server's .env has OPENSHELL_ENABLED=true.
#
# Installs/updates the pinned OpenShell pieces, starts the private gateway,
# registers it with the host CLI and upserts the provider profiles. Exits
# non-zero on any failure; the caller then deploys WITHOUT the OpenShell
# overlay, so a broken sandbox runtime can never block the core deploy.
set -euo pipefail
cd "$(dirname "$0")/../.."
CLI=/usr/local/lib/orvyn-openshell/openshell
COMPOSE=(docker compose -f docker-compose.yml -f infrastructure/ovh/compose.prod.yml
  -f infrastructure/ovh/compose.control-plane.yml -f infrastructure/ovh/compose.worker.yml
  -f infrastructure/ovh/compose.openshell.yml)

bash infrastructure/openshell/setup.sh
"${COMPOSE[@]}" up -d --no-deps openshell-gateway

# Register the private mTLS gateway, then prove an RPC reaches it before
# touching profiles (a registry entry alone does not mean it is serving).
if ! sudo "$CLI" gateway list 2>/dev/null | grep -qE '(^|[[:space:]])orvyn([[:space:]]|$)'; then
  sudo "$CLI" gateway add "https://${OPENSHELL_BRIDGE_IP:-172.17.0.1}:8080" --local --name orvyn
fi
ready=0
for _ in $(seq 1 30); do
  if sudo "$CLI" provider profile list --gateway orvyn >/tmp/orvyn-gateway-ready.log 2>&1; then ready=1; break; fi
  sleep 2
done
if [ "$ready" -ne 1 ]; then
  echo "OpenShell gateway did not answer:" >&2
  cat /tmp/orvyn-gateway-ready.log >&2 || true
  exit 1
fi

sudo "$CLI" provider profile lint --from infrastructure/openshell/provider-profiles
# Imports are create-only, so an existing profile is updated with the
# resource version the live gateway reports (optimistic lock).
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for file in infrastructure/openshell/provider-profiles/*.yaml; do
  id=$(awk '/^id:/ { print $2; exit }' "$file")
  if sudo "$CLI" provider profile export "$id" --global --gateway orvyn --output yaml >"$tmp/current.yaml" 2>/dev/null; then
    version=$(awk '/^resource_version:/ { print $2; exit }' "$tmp/current.yaml")
    test -n "$version"
    awk -v v="$version" 'NR == 1 { print; print "resource_version: " v; next } { print }' "$file" >"$tmp/update.yaml"
    sudo "$CLI" provider profile update "$id" --file "$tmp/update.yaml" --global --gateway orvyn
  else
    sudo "$CLI" provider profile import --file "$file" --global --gateway orvyn
  fi
done
echo "OpenShell gateway ready; profiles up to date"
