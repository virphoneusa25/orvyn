#!/usr/bin/env bash
# Runs on OVH staging after CI has built and published exact-SHA images.
set -euo pipefail

REMOTE="$1"
COMMIT="$2"
BACKEND_IMAGE="$3"
WORKER_IMAGE="$4"
AUTH_DIR="$5"
HEALTH_URL="${STAGING_HEALTH_URL:-http://127.0.0.1:4570/api/v1/health}"
MIN_PREPULL_KB="${STAGING_MIN_PREPULL_KB:-14680064}" # 14 GiB image-pull reserve
MIN_POSTPULL_KB="${STAGING_MIN_POSTPULL_KB:-10485760}" # 10 GiB operating reserve

[[ "$REMOTE" == /home/ubuntu/orvyn-staging-release ]] || { echo "Unsafe staging path" >&2; exit 1; }
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid candidate commit" >&2; exit 1; }
[[ "$BACKEND_IMAGE" =~ ^ghcr\.io/virphoneusa25/orvyn-backend@sha256:[0-9a-f]{64}$ ]] || { echo "Backend image is not an immutable expected GHCR digest" >&2; exit 1; }
[[ "$WORKER_IMAGE" =~ ^ghcr\.io/virphoneusa25/orvyn-worker@sha256:[0-9a-f]{64}$ ]] || { echo "Worker image is not an immutable expected GHCR digest" >&2; exit 1; }
[[ "$AUTH_DIR" =~ ^/tmp/orvyn-ghcr-[A-Za-z0-9._-]+$ ]] || { echo "Unsafe temporary registry credentials path" >&2; exit 1; }
[[ -d "$AUTH_DIR" && ! -L "$AUTH_DIR" ]] || { echo "Temporary registry credentials directory is missing or unsafe" >&2; exit 1; }
[[ -f "$REMOTE/.env.staging" ]] || { echo "Isolated staging configuration is missing" >&2; exit 1; }
[[ -f "$REMOTE/infrastructure/ovh/compose.staging.yml" ]] || { echo "Staging compose file missing" >&2; exit 1; }

export ORVYN_BACKEND_IMAGE="$BACKEND_IMAGE" ORVYN_WORKER_IMAGE="$WORKER_IMAGE"
COMPOSE=(docker compose -p orvyn-staging -f infrastructure/ovh/compose.staging.yml --env-file .env.staging)
cd "$REMOTE"
service_id() {
  local service="$1" id lines
  id="$(docker ps -q --filter 'label=com.docker.compose.project=orvyn-staging' --filter "label=com.docker.compose.service=$service")"
  [[ -n "$id" ]] || { echo "Staging service $service is not running" >&2; return 1; }
  lines="$(wc -l <<<"$id" | tr -d ' ')"
  [[ "$lines" == 1 ]] || { echo "Staging service $service has multiple running containers" >&2; return 1; }
  printf '%s\n' "$id"
}
cleanup_auth() { rm -rf -- "$AUTH_DIR"; }
trap cleanup_auth EXIT

DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}')"
echo "Staging disk and inode preflight before exact digest pull"
df -h "$REMOTE" "$DOCKER_ROOT"
df -i "$REMOTE" "$DOCKER_ROOT"
docker system df -v
docker buildx du --verbose || true
free_kb="$(df -Pk "$DOCKER_ROOT" | awk 'NR==2 {print $4}')"
inode_used="$(df -Pi "$DOCKER_ROOT" | awk 'NR==2 {gsub(/%/, "", $5); print $5}')"
[[ "$free_kb" =~ ^[0-9]+$ ]] && (( free_kb >= MIN_PREPULL_KB )) || {
  echo "Staging has less than 14 GiB available for image pulls; refusing deployment without deleting cache or data" >&2
  exit 1
}
[[ "$inode_used" =~ ^[0-9]+$ ]] && (( inode_used < 98 )) || { echo "Staging Docker filesystem has less than 2% inode reserve" >&2; exit 1; }
if (( free_kb < 20971520 )); then echo "::warning::Staging free disk is below 20 GiB; plan capacity expansion before the 14 GiB deployment stop threshold."; fi

# Record staging state and reserve immutable local rollback references. Never
# touch or recreate the database, Redis, Qdrant, or persistent volumes.
rollback_backend="orvyn-staging-backend:rollback-before-$COMMIT"
rollback_worker="orvyn-staging-worker:rollback-before-$COMMIT"
data_ids="$(for service in postgres-staging redis-staging qdrant-staging; do service_id "$service"; done | sort)"
backend_id="$(docker inspect --format '{{.Image}}' "$(service_id backend-staging)")"
worker_id="$(docker inspect --format '{{.Image}}' "$(service_id worker-staging)")"
docker image inspect "$rollback_backend" >/dev/null 2>&1 || docker image tag "$backend_id" "$rollback_backend"
docker image inspect "$rollback_worker" >/dev/null 2>&1 || docker image tag "$worker_id" "$rollback_worker"
[[ "$(docker image inspect --format '{{.Id}}' "$rollback_backend")" == "$backend_id" ]] || { echo "Existing backend rollback ref does not match the currently running staging image" >&2; exit 1; }
[[ "$(docker image inspect --format '{{.Id}}' "$rollback_worker")" == "$worker_id" ]] || { echo "Existing worker rollback ref does not match the currently running staging image" >&2; exit 1; }

DOCKER_CONFIG="$AUTH_DIR" docker pull "$BACKEND_IMAGE"
DOCKER_CONFIG="$AUTH_DIR" docker pull "$WORKER_IMAGE"
for ref in "$BACKEND_IMAGE" "$WORKER_IMAGE"; do
  repo_digests="$(docker image inspect --format '{{json .RepoDigests}}' "$ref")"
  [[ "$repo_digests" == *"$ref"* ]] || { echo "Pulled image does not advertise requested registry digest" >&2; exit 1; }
done
backend_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$BACKEND_IMAGE")"
worker_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$WORKER_IMAGE")"
[[ "$backend_revision" == "$COMMIT" && "$worker_revision" == "$COMMIT" ]] || { echo "Immutable image revision labels do not match candidate commit" >&2; exit 1; }
free_kb="$(df -Pk "$DOCKER_ROOT" | awk 'NR==2 {print $4}')"
[[ "$free_kb" =~ ^[0-9]+$ ]] && (( free_kb >= MIN_POSTPULL_KB )) || {
  echo "Image pull left less than 10 GiB staging reserve; refusing service replacement" >&2
  exit 1
}
if (( free_kb < 14680064 )); then echo "::warning::Staging free disk is below 14 GiB after pull; capacity expansion is recommended."; fi

printf 'Candidate images verified: backend=%s worker=%s\n' "$BACKEND_IMAGE" "$WORKER_IMAGE"
"${COMPOSE[@]}" up -d --no-build --no-deps backend-staging worker-staging

healthy=false
for _ in $(seq 1 60); do
  backend_container="$(service_id backend-staging 2>/dev/null || true)"
  if [[ -n "$backend_container" ]]; then backend_health="$(docker inspect --format '{{.State.Health.Status}}' "$backend_container" 2>/dev/null || true)"; else backend_health=''; fi
  if [[ "$backend_health" == healthy ]] && docker exec "$backend_container" node -e 'fetch(process.env.ORVYN_STAGING_URL + "/api/v1/health").then(async r => { const j = await r.json(); if (!r.ok || j.commit !== process.argv[1] || j.environment !== "staging") process.exit(1); }).catch(() => process.exit(1))' "$COMMIT"; then
    if docker exec "$backend_container" node -e 'const k=process.env.ORVYN_API_KEY; fetch("http://127.0.0.1:4570/api/v1/worker/list",{headers:k?{"x-api-key":k}:{}}).then(async r=>{const j=await r.json(); if(!r.ok || !(j.workers||[]).some(w=>w.status!=="offline"))process.exit(1)}).catch(()=>process.exit(1))'; then
      healthy=true
      break
    fi
  fi
  sleep 5
done

if [[ "$healthy" != true ]]; then
  echo "Candidate backend or worker health failed; restoring exact previous image IDs" >&2
  export ORVYN_BACKEND_IMAGE="$rollback_backend" ORVYN_WORKER_IMAGE="$rollback_worker"
  "${COMPOSE[@]}" up -d --no-build --no-deps backend-staging worker-staging
  rollback_backend_id="$(docker image inspect --format '{{.Id}}' "$rollback_backend")"
  rollback_worker_id="$(docker image inspect --format '{{.Id}}' "$rollback_worker")"
  for _ in $(seq 1 40); do
    backend_container="$(service_id backend-staging 2>/dev/null || true)"
    if [[ -n "$backend_container" ]]; then backend_health="$(docker inspect --format '{{.State.Health.Status}}' "$backend_container" 2>/dev/null || true)"; else backend_health=''; fi
    worker_container="$(service_id worker-staging 2>/dev/null || true)"
    if [[ -n "$worker_container" ]]; then worker_state="$(docker inspect --format '{{.State.Status}}' "$worker_container" 2>/dev/null || true)"; else worker_state=''; fi
    if [[ "$backend_health" == healthy && "$(docker inspect --format '{{.Image}}' "$backend_container" 2>/dev/null || true)" == "$rollback_backend_id" && "$worker_state" == running && "$(docker inspect --format '{{.Image}}' "$worker_container" 2>/dev/null || true)" == "$rollback_worker_id" ]]; then break; fi
    sleep 5
  done
  rollback_backend_container="$(service_id backend-staging)"
  rollback_worker_container="$(service_id worker-staging)"
  [[ "$(docker inspect --format '{{.Image}}' "$rollback_backend_container")" == "$rollback_backend_id" && "$(docker inspect --format '{{.State.Health.Status}}' "$rollback_backend_container")" == healthy && "$(docker inspect --format '{{.Image}}' "$rollback_worker_container")" == "$rollback_worker_id" && "$(docker inspect --format '{{.State.Status}}' "$rollback_worker_container")" == running ]] || { echo "Rollback did not restore exact image IDs and healthy services" >&2; exit 1; }
  docker inspect --format 'rollback backend image={{.Image}} health={{.State.Health.Status}}' "$(service_id backend-staging)"
  docker inspect --format 'rollback worker image={{.Image}} state={{.State.Status}}' "$(service_id worker-staging)"
  exit 1
fi

new_data_ids="$(for service in postgres-staging redis-staging qdrant-staging; do service_id "$service"; done | sort)"
[[ "$data_ids" == "$new_data_ids" ]] || { echo "Persistent staging data services changed unexpectedly" >&2; exit 1; }
docker inspect --format 'backend={{.Image}} health={{.State.Health.Status}}' "$(service_id backend-staging)"
docker inspect --format 'worker={{.Image}} state={{.State.Status}}' "$(service_id worker-staging)"
curl -fsS "$HEALTH_URL"
echo
df -h "$REMOTE" "$DOCKER_ROOT"
echo "Staging digest deployment verified at $COMMIT; rollback refs $rollback_backend and $rollback_worker retained"
