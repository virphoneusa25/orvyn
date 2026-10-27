#!/usr/bin/env bash
# Exercise the staging rollback references and then restore the exact candidate.
set -euo pipefail

HOST="${OVH_HOST:-ubuntu@40.160.11.123}"
KEY="${OVH_SSH_KEY:-$HOME/.ssh/github_virphone}"
REMOTE="${OVH_REMOTE_DIR:-/home/ubuntu/orvyn-staging-release}"
BASELINE_COMMIT="${STAGING_BASELINE_COMMIT:-}"
CANDIDATE_COMMIT="${STAGING_CANDIDATE_COMMIT:-}"
BACKEND_IMAGE="${ORVYN_BACKEND_IMAGE:-}"
WORKER_IMAGE="${ORVYN_WORKER_IMAGE:-}"
ROLLBACK_BACKEND="${STAGING_ROLLBACK_BACKEND:-}"
ROLLBACK_WORKER="${STAGING_ROLLBACK_WORKER:-}"

[[ "$REMOTE" == /home/ubuntu/orvyn-staging-release ]] || { echo "Unsafe staging path" >&2; exit 1; }
[[ -f "$KEY" ]] || { echo "OVH staging SSH key missing" >&2; exit 1; }
[[ "$BASELINE_COMMIT" =~ ^[0-9a-f]{40}$ && "$CANDIDATE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid staging rollback commit identity" >&2; exit 1; }
[[ "$BACKEND_IMAGE" =~ ^ghcr\.io/virphoneusa25/orvyn-backend@sha256:[0-9a-f]{64}$ ]] || { echo "Candidate backend image is not an exact registry digest" >&2; exit 1; }
[[ "$WORKER_IMAGE" =~ ^ghcr\.io/virphoneusa25/orvyn-worker@sha256:[0-9a-f]{64}$ ]] || { echo "Candidate worker image is not an exact registry digest" >&2; exit 1; }
[[ "$ROLLBACK_BACKEND" == "orvyn-staging-backend:rollback-before-$CANDIDATE_COMMIT" ]] || { echo "Unexpected staging backend rollback reference" >&2; exit 1; }
[[ "$ROLLBACK_WORKER" == "orvyn-staging-worker:rollback-before-$CANDIDATE_COMMIT" ]] || { echo "Unexpected staging worker rollback reference" >&2; exit 1; }

SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
REMOTE_SCRIPT=$(cat <<'REMOTE'
set -euo pipefail
REMOTE="$1" BASELINE_COMMIT="$2" CANDIDATE_COMMIT="$3"
BACKEND_IMAGE="$4" WORKER_IMAGE="$5" ROLLBACK_BACKEND="$6" ROLLBACK_WORKER="$7"
cd "$REMOTE"
COMPOSE=(docker compose -p orvyn-staging -f infrastructure/ovh/compose.staging.yml --env-file .env.staging)
service_id() {
  local service="$1" ids count
  ids="$(docker ps -q --filter 'label=com.docker.compose.project=orvyn-staging' --filter "label=com.docker.compose.service=$service")"
  [[ -n "$ids" ]] || { echo "Staging service $service is not running" >&2; return 1; }
  count="$(wc -l <<<"$ids" | tr -d ' ')"
  [[ "$count" == 1 ]] || { echo "Staging service $service has multiple running containers" >&2; return 1; }
  printf '%s\n' "$ids"
}
worker_idle() {
  local backend
  backend="$(service_id backend-staging)"
  docker exec "$backend" node -e 'const k=process.env.ORVYN_API_KEY;if(!k)process.exit(2);fetch("http://127.0.0.1:4570/api/v1/worker/list",{headers:{"x-api-key":k}}).then(async r=>{const j=await r.json();const ws=j.workers||[];const active=ws.reduce((n,w)=>n+(Number(w.activeRuns)||0),0);const queued=Number(j.queued)||0;console.log(`worker_active_runs=${active} queued_jobs=${queued}`);if(!r.ok||ws.length===0||active!==0||queued!==0)process.exit(1)}).catch(()=>process.exit(1))'
}
data_snapshot() {
  local service id image mounts
  for service in postgres-staging redis-staging qdrant-staging; do
    id="$(service_id "$service")"
    image="$(docker inspect --format '{{.Image}}' "$id")"
    mounts="$(docker inspect --format '{{range .Mounts}}{{if .Name}}{{.Name}}{{end}}:{{.Destination}};{{end}}' "$id")"
    printf '%s %s %s %s\n' "$service" "$id" "$image" "$mounts"
  done | sort
}
release_ready() {
  local commit="$1" backend_ref="$2" worker_ref="$3" backend_id worker_id backend worker health
  backend_id="$(docker image inspect --format '{{.Id}}' "$backend_ref")"
  worker_id="$(docker image inspect --format '{{.Id}}' "$worker_ref")"
  for _ in $(seq 1 40); do
    backend="$(service_id backend-staging 2>/dev/null || true)"
    worker="$(service_id worker-staging 2>/dev/null || true)"
    if [[ -n "$backend" && -n "$worker" ]] \
      && [[ "$(docker inspect --format '{{.Image}}' "$backend" 2>/dev/null || true)" == "$backend_id" ]] \
      && [[ "$(docker inspect --format '{{.State.Health.Status}}' "$backend" 2>/dev/null || true)" == healthy ]] \
      && [[ "$(docker inspect --format '{{.Image}}' "$worker" 2>/dev/null || true)" == "$worker_id" ]] \
      && [[ "$(docker inspect --format '{{.State.Status}}' "$worker" 2>/dev/null || true)" == running ]] \
      && docker exec "$backend" node -e 'const c=process.argv[1];fetch("http://127.0.0.1:4570/api/v1/health").then(async r=>{const j=await r.json();if(!r.ok||j.environment!=="staging"||j.commit!==c)process.exit(1)}).catch(()=>process.exit(1))' "$commit"; then
      if worker_idle; then
        printf 'verified_commit=%s backend_image=%s worker_image=%s\n' "$commit" "$backend_id" "$worker_id"
        return 0
      fi
    fi
    sleep 5
  done
  return 1
}

[[ -f .env.staging ]] || { echo "Staging environment is missing" >&2; exit 1; }
[[ "$(docker image inspect --format '{{.Id}}' "$ROLLBACK_BACKEND")" ]] || { echo "Backend rollback image missing" >&2; exit 1; }
[[ "$(docker image inspect --format '{{.Id}}' "$ROLLBACK_WORKER")" ]] || { echo "Worker rollback image missing" >&2; exit 1; }
before_data="$(data_snapshot)"
worker_idle
release_ready "$CANDIDATE_COMMIT" "$BACKEND_IMAGE" "$WORKER_IMAGE"

rollback_backend_id="$(docker image inspect --format '{{.Id}}' "$ROLLBACK_BACKEND")"
rollback_worker_id="$(docker image inspect --format '{{.Id}}' "$ROLLBACK_WORKER")"
export ORVYN_BACKEND_IMAGE="$ROLLBACK_BACKEND" ORVYN_WORKER_IMAGE="$ROLLBACK_WORKER"
"${COMPOSE[@]}" up -d --no-build --no-deps backend-staging worker-staging
release_ready "$BASELINE_COMMIT" "$ROLLBACK_BACKEND" "$ROLLBACK_WORKER"
[[ "$(data_snapshot)" == "$before_data" ]] || { echo "Persistent staging data service identities changed during rollback rehearsal" >&2; exit 1; }
printf 'rollback_health_check=passed backend_image_id=%s worker_image_id=%s baseline_commit=%s\n' "$rollback_backend_id" "$rollback_worker_id" "$BASELINE_COMMIT"

worker_idle
export ORVYN_BACKEND_IMAGE="$BACKEND_IMAGE" ORVYN_WORKER_IMAGE="$WORKER_IMAGE"
"${COMPOSE[@]}" up -d --no-build --no-deps backend-staging worker-staging
release_ready "$CANDIDATE_COMMIT" "$BACKEND_IMAGE" "$WORKER_IMAGE"
[[ "$(data_snapshot)" == "$before_data" ]] || { echo "Persistent staging data service identities changed when restoring the candidate" >&2; exit 1; }
echo "PASS: exact rollback image references and health checks verified; exact candidate restored"
REMOTE
)

printf '%s\n' "$REMOTE_SCRIPT" | "${SSH[@]}" "$HOST" bash -s -- \
  "$REMOTE" "$BASELINE_COMMIT" "$CANDIDATE_COMMIT" \
  "$BACKEND_IMAGE" "$WORKER_IMAGE" "$ROLLBACK_BACKEND" "$ROLLBACK_WORKER"
