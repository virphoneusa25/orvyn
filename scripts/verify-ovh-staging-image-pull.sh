#!/usr/bin/env bash
# Pull and validate exact candidate digests on staging without replacing any
# running service. A candidate-specific rollback tag is created from each
# currently running application image ID and verified before candidate pulls.
set -euo pipefail
HOST="${OVH_HOST:-ubuntu@40.160.11.123}"
KEY="${OVH_SSH_KEY:-$HOME/.ssh/github_virphone}"
COMMIT="$(git rev-parse HEAD)"
BACKEND_IMAGE="${ORVYN_BACKEND_IMAGE:-}"
WORKER_IMAGE="${ORVYN_WORKER_IMAGE:-}"
GHCR_USERNAME="${GHCR_USERNAME:-}"
GHCR_TOKEN="${GHCR_TOKEN:-}"
[[ -f "$KEY" ]] || { echo "OVH staging SSH key missing" >&2; exit 1; }
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid candidate commit" >&2; exit 1; }
[[ "$BACKEND_IMAGE" =~ ^ghcr\.io/virphoneusa25/orvyn-backend@sha256:[0-9a-f]{64}$ ]] || { echo "Missing exact backend GHCR digest" >&2; exit 1; }
[[ "$WORKER_IMAGE" =~ ^ghcr\.io/virphoneusa25/orvyn-worker@sha256:[0-9a-f]{64}$ ]] || { echo "Missing exact worker GHCR digest" >&2; exit 1; }
[[ -n "$GHCR_USERNAME" && -n "$GHCR_TOKEN" ]] || { echo "Staging registry credentials missing" >&2; exit 1; }
SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
AUTH_DIR="/tmp/orvyn-ghcr-verify-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}"

if ! printf '%s' "$GHCR_TOKEN" | "${SSH[@]}" "$HOST" "set -eu; mkdir -m 700 -p '$AUTH_DIR'; if ! DOCKER_CONFIG='$AUTH_DIR' docker login ghcr.io --username '$GHCR_USERNAME' --password-stdin >/dev/null; then rm -rf -- '$AUTH_DIR'; exit 1; fi"; then
  echo "Staging host cannot read the private GHCR packages" >&2
  exit 1
fi
cleanup_auth() { "${SSH[@]}" "$HOST" "rm -rf -- '$AUTH_DIR'" >/dev/null 2>&1 || true; }
trap cleanup_auth EXIT

if ! { cat <<'REMOTE'
set -euo pipefail
COMMIT="$1" BACKEND_IMAGE="$2" WORKER_IMAGE="$3" AUTH_DIR="$4"
[[ "$AUTH_DIR" =~ ^/tmp/orvyn-ghcr-verify-[A-Za-z0-9._-]+$ && -d "$AUTH_DIR" && ! -L "$AUTH_DIR" ]]
export DOCKER_CONFIG="$AUTH_DIR"
DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}')"
df -h "$DOCKER_ROOT"
df -i "$DOCKER_ROOT"
docker system df -v
docker buildx du --verbose || true
free_kb="$(df -Pk "$DOCKER_ROOT" | awk 'NR==2 {print $4}')"
inode_used="$(df -Pi "$DOCKER_ROOT" | awk 'NR==2 {gsub(/%/, "", $5); print $5}')"
[[ "$free_kb" =~ ^[0-9]+$ && "$free_kb" -ge 14680064 ]] || { echo "Below 14 GiB pull reserve" >&2; exit 1; }
[[ "$inode_used" =~ ^[0-9]+$ && "$inode_used" -lt 98 ]] || { echo "Below 2% inode reserve" >&2; exit 1; }
for container in backend-staging worker-staging postgres-staging redis-staging qdrant-staging; do docker inspect "$container" >/dev/null; done
before_services="$(docker inspect --format '{{.Id}} {{.Image}}' backend-staging worker-staging postgres-staging redis-staging qdrant-staging | sort)"
backend_id="$(docker inspect --format '{{.Image}}' backend-staging)"
worker_id="$(docker inspect --format '{{.Image}}' worker-staging)"
rollback_backend="orvyn-staging-backend:rollback-before-$COMMIT"
rollback_worker="orvyn-staging-worker:rollback-before-$COMMIT"
docker image inspect "$rollback_backend" >/dev/null 2>&1 || docker image tag "$backend_id" "$rollback_backend"
docker image inspect "$rollback_worker" >/dev/null 2>&1 || docker image tag "$worker_id" "$rollback_worker"
[[ "$(docker image inspect --format '{{.Id}}' "$rollback_backend")" == "$backend_id" ]]
[[ "$(docker image inspect --format '{{.Id}}' "$rollback_worker")" == "$worker_id" ]]
DOCKER_CONFIG="$AUTH_DIR" docker pull "$BACKEND_IMAGE"
DOCKER_CONFIG="$AUTH_DIR" docker pull "$WORKER_IMAGE"
for ref in "$BACKEND_IMAGE" "$WORKER_IMAGE"; do
  repo_digests="$(docker image inspect --format '{{json .RepoDigests}}' "$ref")"
  [[ "$repo_digests" == *"$ref"* ]] || { echo "Registry digest mismatch" >&2; exit 1; }
done
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$BACKEND_IMAGE")" == "$COMMIT" ]]
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$WORKER_IMAGE")" == "$COMMIT" ]]
free_kb="$(df -Pk "$DOCKER_ROOT" | awk 'NR==2 {print $4}')"
[[ "$free_kb" =~ ^[0-9]+$ && "$free_kb" -ge 10485760 ]] || { echo "Image pull consumed operating reserve; no services were replaced" >&2; exit 1; }
after_services="$(docker inspect --format '{{.Id}} {{.Image}}' backend-staging worker-staging postgres-staging redis-staging qdrant-staging | sort)"
[[ "$before_services" == "$after_services" ]] || { echo "A running staging service changed during pull-only validation" >&2; exit 1; }
printf 'commit=%s\nbackend=%s\nworker=%s\nbackendRollback=%s (%s)\nworkerRollback=%s (%s)\n' "$COMMIT" "$BACKEND_IMAGE" "$WORKER_IMAGE" "$rollback_backend" "$backend_id" "$rollback_worker" "$worker_id"
df -h "$DOCKER_ROOT"
echo "PASS: exact-SHA images pulled, labels/digests verified, rollback IDs preserved, running service identities unchanged"
REMOTE
} | "${SSH[@]}" "$HOST" "bash -s -- '$COMMIT' '$BACKEND_IMAGE' '$WORKER_IMAGE' '$AUTH_DIR'"; then
  exit 1
fi
