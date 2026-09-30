#!/usr/bin/env bash
# infrastructure/openshell/accept.sh — the live acceptance gate. Runs the real
# gateway suite inside the freshly built worker and prints PASS/FAIL. The
# caller (remote-deploy.sh) flips OPENSHELL_ACCEPTANCE_PASSED only on success.
set -euo pipefail
cd "$(dirname "$0")/../.."
COMPOSE=(docker compose -f docker-compose.yml -f infrastructure/ovh/compose.prod.yml
  -f infrastructure/ovh/compose.control-plane.yml -f infrastructure/ovh/compose.worker.yml
  -f infrastructure/ovh/compose.openshell.yml)
DIR=/opt/orvyn/workspaces/_acceptance
sudo mkdir -p "$DIR"
sudo rm -f "$DIR/report.json"
"${COMPOSE[@]}" exec -T \
  -e ORVYN_WORKER_DIST=/app/dist/sandbox \
  -e ORVYN_TEST_DOCKER_IMAGE=orvyn/sandbox:0.1.2-2 \
  -e ORVYN_TEST_WORKSPACE_ROOT="$DIR" \
  worker node /app/acceptance/openshell-sandbox.mjs --json "$DIR/report.json"
sudo install -D -m 0644 "$DIR/report.json" /var/lib/openshell/acceptance.json
