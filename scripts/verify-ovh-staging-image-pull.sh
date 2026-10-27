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
MIN_PREPULL_KB="${STAGING_MIN_PREPULL_KB:-14680064}"
MIN_POSTPULL_KB="${STAGING_MIN_POSTPULL_KB:-10485760}"
WARNING_KB="${STAGING_STORAGE_WARNING_KB:-20971520}"
[[ -f "$KEY" ]] || { echo "OVH staging SSH key missing" >&2; exit 1; }
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid candidate commit" >&2; exit 1; }
[[ "$BACKEND_IMAGE" =~ ^ghcr\.io/virphoneusa25/orvyn-backend@sha256:[0-9a-f]{64}$ ]] || { echo "Missing exact backend GHCR digest" >&2; exit 1; }
[[ "$WORKER_IMAGE" =~ ^ghcr\.io/virphoneusa25/orvyn-worker@sha256:[0-9a-f]{64}$ ]] || { echo "Missing exact worker GHCR digest" >&2; exit 1; }
[[ -n "$GHCR_USERNAME" && -n "$GHCR_TOKEN" ]] || { echo "Staging registry credentials missing" >&2; exit 1; }
for value in "$MIN_PREPULL_KB" "$MIN_POSTPULL_KB" "$WARNING_KB"; do [[ "$value" =~ ^[0-9]+$ ]] || { echo "Staging disk thresholds must be integer KiB values" >&2; exit 1; }; done
(( MIN_PREPULL_KB >= MIN_POSTPULL_KB && WARNING_KB >= MIN_PREPULL_KB )) || { echo "Staging disk thresholds are inconsistent" >&2; exit 1; }
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
COMMIT="$1" BACKEND_IMAGE="$2" WORKER_IMAGE="$3" AUTH_DIR="$4" MIN_PREPULL_KB="$5" MIN_POSTPULL_KB="$6" WARNING_KB="$7"
[[ "$AUTH_DIR" =~ ^/tmp/orvyn-ghcr-verify-[A-Za-z0-9._-]+$ && -d "$AUTH_DIR" && ! -L "$AUTH_DIR" ]]
export DOCKER_CONFIG="$AUTH_DIR"
service_id() {
  local service="$1" id lines
  id="$(docker ps -q --filter 'label=com.docker.compose.project=orvyn-staging' --filter "label=com.docker.compose.service=$service")"
  [[ -n "$id" ]] || { echo "Staging service $service is not running" >&2; return 1; }
  lines="$(wc -l <<<"$id" | tr -d ' ')"
  [[ "$lines" == 1 ]] || { echo "Staging service $service has multiple running containers" >&2; return 1; }
  printf '%s\n' "$id"
}
service_snapshot() {
  for service in backend-staging worker-staging postgres-staging redis-staging qdrant-staging; do
    id="$(service_id "$service")"
    printf '%s %s\n' "$id" "$(docker inspect --format '{{.Image}}' "$id")"
  done | sort
}
worker_idle() {
  local container="$1"
  docker exec "$container" node -e 'const k=process.env.ORVYN_API_KEY;if(!k)process.exit(2);fetch("http://127.0.0.1:4570/api/v1/worker/list",{headers:{"x-api-key":k}}).then(async r=>{const j=await r.json();const workers=j.workers||[];const active=workers.reduce((n,w)=>n+(Number(w.activeRuns)||0),0);const queued=Number(j.queued)||0;console.log(`worker_active_runs=${active} queued_jobs=${queued}`);if(!r.ok||workers.length===0||active!==0||queued!==0)process.exit(1)}).catch(()=>process.exit(1))'
}
assert_secret_free_image() {
  local ref="$1" secret_names
  secret_names="$(docker image inspect --format '{{range .Config.Env}}{{println (index (split . "=") 0)}}{{end}}' "$ref" | grep -Ei 'API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_?KEY|DATABASE_URL|PG_URL|REDIS_URL' || true)"
  [[ -z "$secret_names" ]] || { echo "Rollback snapshot contains credential-like image environment keys" >&2; return 1; }
}
snapshot_worker_without_runtime_environment() {
  local container="$1" source_id="$2" ref="$3" metadata created=false change path
  worker_idle "$(service_id backend-staging)"
  while read -r change path; do
    case "$path" in
      /run|/run/*|/opt|/opt/orvyn|/opt/orvyn/workspaces-staging|/opt/orvyn/workspaces-staging/*) ;;
      *) echo "Worker root filesystem changed outside runtime or mounted workspace paths; refusing rollback snapshot" >&2; return 1 ;;
    esac
  done < <(docker diff "$container")
  # docker export excludes mounted volumes; importing it drops runtime Env
  # values (including credentials) while preserving the running worker rootfs.
  if ! docker image inspect "$ref" >/dev/null 2>&1; then
    if ! docker export "$container" | docker import \
      --change 'WORKDIR /app' \
      --change 'ENTRYPOINT ["docker-entrypoint.sh"]' \
      --change 'CMD ["node","dist/index.js"]' \
      --change "LABEL org.orvyn.rollback.source-image-id=$source_id" - "$ref" >/dev/null; then
      docker image rm "$ref" >/dev/null 2>&1 || true
      return 1
    fi
    created=true
  fi
  metadata="$(docker image inspect "$ref" --format '{{.Config.WorkingDir}}|{{json .Config.Entrypoint}}|{{json .Config.Cmd}}|{{index .Config.Labels "org.orvyn.rollback.source-image-id"}}')" || { if [[ "$created" == true ]]; then docker image rm "$ref" >/dev/null 2>&1 || true; fi; return 1; }
  if [[ "$metadata" != "/app|[\"docker-entrypoint.sh\"]|[\"node\",\"dist/index.js\"]|$source_id" ]] || ! assert_secret_free_image "$ref" || ! docker run --rm --network none --entrypoint /bin/sh "$ref" -c 'test -f /app/dist/index.js && test -x /usr/local/bin/docker-entrypoint.sh' || ! worker_idle "$(service_id backend-staging)"; then
    echo "Credential-free worker rollback image failed its identity, metadata, or idle checks" >&2
    if [[ "$created" == true ]]; then docker image rm "$ref" >/dev/null 2>&1 || true; fi
    return 1
  fi
  printf 'worker_rollback_snapshot_source=%s worker_rollback_image=%s\n' "$source_id" "$(docker image inspect --format '{{.Id}}' "$ref")"
}
DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}')"
df -h "$DOCKER_ROOT"
df -i "$DOCKER_ROOT"
docker system df -v
docker buildx du --verbose || true
free_kb="$(df -Pk "$DOCKER_ROOT" | awk 'NR==2 {print $4}')"
inode_used="$(df -Pi "$DOCKER_ROOT" | awk 'NR==2 {gsub(/%/, "", $5); print $5}')"
if [[ "$free_kb" =~ ^[0-9]+$ ]] && (( free_kb < MIN_PREPULL_KB )); then
  echo "Staging is below the image-pull reserve; reclaiming only unused regular Docker build cache (no images, containers, or volumes)"
  docker buildx prune --filter type=regular --min-free-space 16GB --force
  free_kb="$(df -Pk "$DOCKER_ROOT" | awk 'NR==2 {print $4}')"
fi
if [[ "$free_kb" =~ ^[0-9]+$ ]] && (( free_kb < MIN_PREPULL_KB )); then
  echo "Build-cache cleanup did not restore the reserve; checking only untagged, inactive ORVYN release images that are not rollback images"
  while IFS= read -r image_id; do
    [[ -n "$image_id" ]] || continue
    metadata="$(docker image inspect "$image_id" --format '{{index .Config.Labels "org.opencontainers.image.source"}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "org.orvyn.rollback.source-image-id"}}|{{json .RepoTags}}')"
    IFS='|' read -r source revision rollback_source repo_tags <<<"$metadata"
    [[ "$source" == 'https://github.com/virphoneusa25/orvyn' && "$revision" =~ ^[0-9a-f]{40}$ && "$revision" != "$COMMIT" ]] || continue
    [[ -z "$rollback_source" ]] || continue
    [[ "$repo_tags" == 'null' || "$repo_tags" == '[]' || "$repo_tags" == '["<none>:<none>"]' ]] || continue
    if docker ps -aq --filter "ancestor=$image_id" | grep -q .; then continue; fi
    echo "Removing verified-unused untagged release image revision=$revision image=${image_id#sha256:} (no container or rollback reference)"
    docker image rm "$image_id" >/dev/null
  done < <(docker image ls -aq --filter 'label=org.opencontainers.image.source=https://github.com/virphoneusa25/orvyn' | sort -u)
  free_kb="$(df -Pk "$DOCKER_ROOT" | awk 'NR==2 {print $4}')"
fi
[[ "$free_kb" =~ ^[0-9]+$ && "$free_kb" -ge "$MIN_PREPULL_KB" ]] || { echo "Below configured image-pull reserve ($MIN_PREPULL_KB KiB)" >&2; exit 1; }
[[ "$inode_used" =~ ^[0-9]+$ && "$inode_used" -lt 98 ]] || { echo "Below 2% inode reserve" >&2; exit 1; }
if (( free_kb < WARNING_KB )); then echo "::warning::Staging free disk is below configured warning reserve ($WARNING_KB KiB)."; fi
before_services="$(service_snapshot)"
backend_id="$(docker inspect --format '{{.Image}}' "$(service_id backend-staging)")"
worker_id="$(docker inspect --format '{{.Image}}' "$(service_id worker-staging)")"
rollback_backend="orvyn-staging-backend:rollback-before-$COMMIT"
rollback_worker="orvyn-staging-worker:rollback-before-$COMMIT"
if ! docker image inspect "$rollback_backend" >/dev/null 2>&1; then docker image tag "$backend_id" "$rollback_backend"; fi
[[ "$(docker image inspect --format '{{.Id}}' "$rollback_backend")" == "$backend_id" ]]
if docker image inspect "$rollback_worker" >/dev/null 2>&1; then
  rollback_worker_id="$(docker image inspect --format '{{.Id}}' "$rollback_worker")"
  if [[ "$rollback_worker_id" != "$worker_id" ]]; then
    [[ "$(docker image inspect --format '{{index .Config.Labels "org.orvyn.rollback.source-image-id"}}' "$rollback_worker")" == "$worker_id" ]]
    snapshot_worker_without_runtime_environment "$(service_id worker-staging)" "$worker_id" "$rollback_worker"
  fi
elif docker image inspect "$worker_id" >/dev/null 2>&1; then
  docker image tag "$worker_id" "$rollback_worker"
else
  snapshot_ref="orvyn-staging-worker:rollback-snapshot-${worker_id#sha256:}"
  snapshot_worker_without_runtime_environment "$(service_id worker-staging)" "$worker_id" "$snapshot_ref"
  docker image tag "$snapshot_ref" "$rollback_worker"
fi
free_kb="$(df -Pk "$DOCKER_ROOT" | awk 'NR==2 {print $4}')"
[[ "$free_kb" =~ ^[0-9]+$ && "$free_kb" -ge "$MIN_PREPULL_KB" ]] || { echo "Rollback preparation left less than configured pull reserve; candidate images were not pulled" >&2; exit 1; }
DOCKER_CONFIG="$AUTH_DIR" docker pull "$BACKEND_IMAGE"
DOCKER_CONFIG="$AUTH_DIR" docker pull "$WORKER_IMAGE"
for ref in "$BACKEND_IMAGE" "$WORKER_IMAGE"; do
  repo_digests="$(docker image inspect --format '{{json .RepoDigests}}' "$ref")"
  [[ "$repo_digests" == *"$ref"* ]] || { echo "Registry digest mismatch" >&2; exit 1; }
done
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$BACKEND_IMAGE")" == "$COMMIT" ]]
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$WORKER_IMAGE")" == "$COMMIT" ]]
free_kb="$(df -Pk "$DOCKER_ROOT" | awk 'NR==2 {print $4}')"
[[ "$free_kb" =~ ^[0-9]+$ && "$free_kb" -ge "$MIN_POSTPULL_KB" ]] || { echo "Image pull consumed configured operating reserve; no services were replaced" >&2; exit 1; }
if (( free_kb < WARNING_KB )); then echo "::warning::Staging free disk is below configured warning reserve ($WARNING_KB KiB)."; fi
after_services="$(service_snapshot)"
[[ "$before_services" == "$after_services" ]] || { echo "A running staging service changed during pull-only validation" >&2; exit 1; }
printf 'commit=%s\nbackend=%s\nworker=%s\nbackendRollback=%s (%s)\nworkerRollback=%s (%s)\n' "$COMMIT" "$BACKEND_IMAGE" "$WORKER_IMAGE" "$rollback_backend" "$backend_id" "$rollback_worker" "$(docker image inspect --format '{{.Id}}' "$rollback_worker")"
df -h "$DOCKER_ROOT"
echo "PASS: exact-SHA images pulled, labels/digests verified, rollback IDs preserved, running service identities unchanged"
REMOTE
} | "${SSH[@]}" "$HOST" "bash -s -- '$COMMIT' '$BACKEND_IMAGE' '$WORKER_IMAGE' '$AUTH_DIR' '$MIN_PREPULL_KB' '$MIN_POSTPULL_KB' '$WARNING_KB'"; then
  exit 1
fi
