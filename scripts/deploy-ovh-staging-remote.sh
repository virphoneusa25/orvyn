#!/usr/bin/env bash
# Runs on OVH staging after CI has built and published exact-SHA images.
set -euo pipefail

REMOTE="$1"
COMMIT="$2"
BACKEND_IMAGE="$3"
WORKER_IMAGE="$4"
AUTH_DIR="$5"
MIN_PREPULL_KB="${STAGING_MIN_PREPULL_KB:-14680064}" # 14 GiB image-pull reserve
MIN_POSTPULL_KB="${STAGING_MIN_POSTPULL_KB:-10485760}" # 10 GiB operating reserve
WARNING_KB="${STAGING_STORAGE_WARNING_KB:-20971520}" # 20 GiB capacity warning

[[ "$REMOTE" == /home/ubuntu/orvyn-staging-release ]] || { echo "Unsafe staging path" >&2; exit 1; }
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid candidate commit" >&2; exit 1; }
[[ "$BACKEND_IMAGE" =~ ^ghcr\.io/virphoneusa25/orvyn-backend@sha256:[0-9a-f]{64}$ ]] || { echo "Backend image is not an immutable expected GHCR digest" >&2; exit 1; }
[[ "$WORKER_IMAGE" =~ ^ghcr\.io/virphoneusa25/orvyn-worker@sha256:[0-9a-f]{64}$ ]] || { echo "Worker image is not an immutable expected GHCR digest" >&2; exit 1; }
[[ "$AUTH_DIR" =~ ^/tmp/orvyn-ghcr-[A-Za-z0-9._-]+$ ]] || { echo "Unsafe temporary registry credentials path" >&2; exit 1; }
for value in "$MIN_PREPULL_KB" "$MIN_POSTPULL_KB" "$WARNING_KB"; do [[ "$value" =~ ^[0-9]+$ ]] || { echo "Staging disk thresholds must be integer KiB values" >&2; exit 1; }; done
(( MIN_PREPULL_KB >= MIN_POSTPULL_KB && WARNING_KB >= MIN_PREPULL_KB )) || { echo "Staging disk thresholds are inconsistent" >&2; exit 1; }
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
worker_idle() {
  local container="$1"
  docker exec "$container" node -e 'const k=process.env.ORVYN_API_KEY;if(!k)process.exit(2);fetch("http://127.0.0.1:4570/api/v1/worker/list",{headers:{"x-api-key":k}}).then(async r=>{const j=await r.json();const workers=j.workers||[];const active=workers.reduce((n,w)=>n+(Number(w.activeRuns)||0),0);const queued=Number(j.queued)||0;console.log(`worker_active_runs=${active} queued_jobs=${queued}`);if(!r.ok||workers.length===0||active!==0||queued!==0)process.exit(1)}).catch(()=>process.exit(1))'
}
data_snapshot() {
  for service in postgres-staging redis-staging qdrant-staging; do
    local id image mounts
    id="$(service_id "$service")"
    image="$(docker inspect --format '{{.Image}}' "$id")"
    mounts="$(docker inspect --format '{{range .Mounts}}{{if .Name}}{{.Name}}{{end}}:{{.Destination}};{{end}}' "$id")"
    printf '%s %s %s %s\n' "$service" "$id" "$image" "$mounts"
  done | sort
}
cleanup_auth() { rm -rf -- "$AUTH_DIR"; }
replacement_started=false
rollback_backend=""
rollback_worker=""
rollback_backend_id=""
rollback_worker_id=""
baseline_commit=""
restore_previous() {
  [[ -n "$rollback_backend" && -n "$rollback_worker" && -n "$rollback_backend_id" && -n "$rollback_worker_id" && -n "$baseline_commit" ]] || return 1
  export ORVYN_BACKEND_IMAGE="$rollback_backend" ORVYN_WORKER_IMAGE="$rollback_worker"
  "${COMPOSE[@]}" up -d --no-build --no-deps backend-staging worker-staging || true
  for _ in $(seq 1 40); do
    local backend worker
    backend="$(service_id backend-staging 2>/dev/null || true)"
    worker="$(service_id worker-staging 2>/dev/null || true)"
    if [[ -n "$backend" && -n "$worker" ]] \
      && [[ "$(docker inspect --format '{{.Image}}' "$backend" 2>/dev/null || true)" == "$rollback_backend_id" ]] \
      && [[ "$(docker inspect --format '{{.State.Health.Status}}' "$backend" 2>/dev/null || true)" == healthy ]] \
      && [[ "$(docker inspect --format '{{.Image}}' "$worker" 2>/dev/null || true)" == "$rollback_worker_id" ]] \
      && [[ "$(docker inspect --format '{{.State.Status}}' "$worker" 2>/dev/null || true)" == running ]] \
      && docker exec "$backend" node -e 'const c=process.argv[1];fetch("http://127.0.0.1:4570/api/v1/health").then(async r=>{const j=await r.json();if(!r.ok||j.environment!=="staging"||j.commit!==c)process.exit(1)}).catch(()=>process.exit(1))' "$baseline_commit" \
      && docker exec "$backend" node -e 'const k=process.env.ORVYN_API_KEY;fetch("http://127.0.0.1:4570/api/v1/worker/list",{headers:{"x-api-key":k}}).then(async r=>{const j=await r.json();if(!r.ok||!(j.workers||[]).some(w=>w.status!=="offline"))process.exit(1)}).catch(()=>process.exit(1))' \
      && [[ "$(data_snapshot)" == "$data_ids" ]]; then
      echo "Rollback restored baseline commit $baseline_commit with exact backend/worker image IDs and healthy staging services"
      return 0
    fi
    sleep 5
  done
  echo "Failed to restore and verify the preserved staging images" >&2
  return 1
}
on_exit() {
  local status=$?
  trap - EXIT
  if [[ "$status" -ne 0 && "$replacement_started" == true ]]; then
    echo "Deployment interrupted after service replacement; attempting exact staging rollback" >&2
    restore_previous || status=1
  fi
  cleanup_auth
  exit "$status"
}
trap on_exit EXIT

DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}')"
worker_idle "$(service_id backend-staging)"
echo "Staging disk and inode preflight before exact digest pull"
df -h "$REMOTE" "$DOCKER_ROOT"
df -i "$REMOTE" "$DOCKER_ROOT"
docker system df -v
docker buildx du --verbose || true
free_kb="$(df -Pk "$DOCKER_ROOT" | awk 'NR==2 {print $4}')"
inode_used="$(df -Pi "$DOCKER_ROOT" | awk 'NR==2 {gsub(/%/, "", $5); print $5}')"
[[ "$free_kb" =~ ^[0-9]+$ ]] && (( free_kb >= MIN_PREPULL_KB )) || {
  echo "Staging has less than the configured $MIN_PREPULL_KB KiB image-pull reserve; refusing deployment without deleting cache or data" >&2
  exit 1
}
[[ "$inode_used" =~ ^[0-9]+$ ]] && (( inode_used < 98 )) || { echo "Staging Docker filesystem has less than 2% inode reserve" >&2; exit 1; }
if (( free_kb < WARNING_KB )); then echo "::warning::Staging free disk is below configured warning reserve ($WARNING_KB KiB); plan capacity expansion before the $MIN_PREPULL_KB KiB deployment stop threshold."; fi

# Record staging state and reserve immutable local rollback references. Never
# touch or recreate the database, Redis, Qdrant, or persistent volumes.
rollback_backend="orvyn-staging-backend:rollback-before-$COMMIT"
rollback_worker="orvyn-staging-worker:rollback-before-$COMMIT"
data_ids="$(data_snapshot)"
backend_id="$(docker inspect --format '{{.Image}}' "$(service_id backend-staging)")"
worker_id="$(docker inspect --format '{{.Image}}' "$(service_id worker-staging)")"
if ! docker image inspect "$rollback_backend" >/dev/null 2>&1; then docker image tag "$backend_id" "$rollback_backend"; fi
if ! docker image inspect "$rollback_worker" >/dev/null 2>&1; then
  if docker image inspect "$worker_id" >/dev/null 2>&1; then
    docker image tag "$worker_id" "$rollback_worker"
  else
    echo "The exact running worker image is absent and the pull-only gate did not create a credential-free rollback snapshot" >&2
    exit 1
  fi
fi
[[ "$(docker image inspect --format '{{.Id}}' "$rollback_backend")" == "$backend_id" ]] || { echo "Existing backend rollback ref does not match the currently running staging image" >&2; exit 1; }
rollback_worker_id="$(docker image inspect --format '{{.Id}}' "$rollback_worker")"
if [[ "$rollback_worker_id" != "$worker_id" ]]; then
  [[ "$(docker image inspect --format '{{index .Config.Labels "org.orvyn.rollback.source-image-id"}}' "$rollback_worker")" == "$worker_id" ]] || { echo "Worker rollback snapshot does not identify the current running worker image" >&2; exit 1; }
  secret_names="$(docker image inspect --format '{{range .Config.Env}}{{println (index (split . "=") 0)}}{{end}}' "$rollback_worker" | grep -Ei 'API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_?KEY|DATABASE_URL|PG_URL|REDIS_URL' || true)"
  [[ -z "$secret_names" ]] || { echo "Worker rollback snapshot has credential-like image environment keys" >&2; exit 1; }
  metadata="$(docker image inspect "$rollback_worker" --format '{{.Config.WorkingDir}}|{{json .Config.Entrypoint}}|{{json .Config.Cmd}}')"
  [[ "$metadata" == '/app|["docker-entrypoint.sh"]|["node","dist/index.js"]' ]] || { echo "Worker rollback snapshot startup configuration is invalid" >&2; exit 1; }
  docker run --rm --network none --entrypoint /bin/sh "$rollback_worker" -c 'test -f /app/dist/index.js && test -x /usr/local/bin/docker-entrypoint.sh'
fi
baseline_commit="$(docker exec "$(service_id backend-staging)" node -e 'fetch("http://127.0.0.1:4570/api/v1/health").then(async r=>{const j=await r.json();if(!r.ok||j.environment!=="staging"||! /^[0-9a-f]{40}$/.test(j.commit||""))process.exit(1);console.log(j.commit)}).catch(()=>process.exit(1))')"
[[ "$baseline_commit" =~ ^[0-9a-f]{40}$ ]] || { echo "Could not capture the current staging release identity" >&2; exit 1; }
rollback_backend_id="$(docker image inspect --format '{{.Id}}' "$rollback_backend")"
rollback_worker_id="$(docker image inspect --format '{{.Id}}' "$rollback_worker")"

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
  echo "Image pull left less than configured $MIN_POSTPULL_KB KiB staging reserve; refusing service replacement" >&2
  exit 1
}
if (( free_kb < MIN_PREPULL_KB )); then echo "::warning::Staging free disk is below configured pull reserve ($MIN_PREPULL_KB KiB) after pull; capacity expansion is recommended."; fi

printf 'Candidate images verified: backend=%s worker=%s\n' "$BACKEND_IMAGE" "$WORKER_IMAGE"
worker_idle "$(service_id backend-staging)"
replacement_started=true
"${COMPOSE[@]}" up -d --no-build --no-deps backend-staging worker-staging

healthy=false
for _ in $(seq 1 60); do
  backend_container="$(service_id backend-staging 2>/dev/null || true)"
  if [[ -n "$backend_container" ]]; then backend_health="$(docker inspect --format '{{.State.Health.Status}}' "$backend_container" 2>/dev/null || true)"; else backend_health=''; fi
  if [[ "$backend_health" == healthy ]] && docker exec "$backend_container" node -e 'fetch("http://127.0.0.1:4570/api/v1/health").then(async r => { const j = await r.json(); if (!r.ok || j.commit !== process.argv[1] || j.environment !== "staging") process.exit(1); }).catch(() => process.exit(1))' "$COMMIT"; then
    if docker exec "$backend_container" node -e 'const k=process.env.ORVYN_API_KEY; fetch("http://127.0.0.1:4570/api/v1/worker/list",{headers:k?{"x-api-key":k}:{}}).then(async r=>{const j=await r.json(); if(!r.ok || !(j.workers||[]).some(w=>w.status!=="offline"))process.exit(1)}).catch(()=>process.exit(1))'; then
      healthy=true
      break
    fi
  fi
  sleep 5
done

if [[ "$healthy" != true ]]; then
  echo "Candidate backend or worker health failed; restoring the preserved staging references" >&2
  restore_previous || exit 1
  replacement_started=false
  exit 1
fi

[[ "$(data_snapshot)" == "$data_ids" ]] || { echo "Persistent staging data services or named volumes changed unexpectedly" >&2; exit 1; }
docker inspect --format 'backend={{.Image}} health={{.State.Health.Status}}' "$(service_id backend-staging)"
docker inspect --format 'worker={{.Image}} state={{.State.Status}}' "$(service_id worker-staging)"
docker exec "$(service_id backend-staging)" node -e 'const c=process.argv[1];fetch("http://127.0.0.1:4570/api/v1/health").then(async r=>{const j=await r.json();if(!r.ok||j.environment!=="staging"||j.commit!==c)process.exit(1);console.log(JSON.stringify({status:j.status,environment:j.environment,commit:j.commit}))}).catch(()=>process.exit(1))' "$COMMIT"
df -h "$REMOTE" "$DOCKER_ROOT"
replacement_started=false
echo "Staging digest deployment verified at $COMMIT; rollback refs $rollback_backend and $rollback_worker retained"
