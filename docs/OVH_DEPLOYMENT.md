# Deploying ORVYN to OVH Cloud

> **Status: DEPLOYED (2026-09-14).** Live on an OVH b3-16 instance at
> `40.160.11.123` (Ubuntu 24.04, Docker Compose: backend + Caddy + Ollama).
> Verified from the public internet: health, auth enforcement (401),
> registration/login, rate limiting (X-RateLimit headers), quota/queue
> reporting, and persistence across container rebuilds (named volume
> `orvyn-data`). Currently **HTTP-only**: point a domain's A record at the
> IP, set `DOMAIN` in `~/orvyn/.env` on the server, and
> `docker compose restart caddy` for automatic HTTPS. The admin API key is
> in `.ovh-api-key.txt` at the repo root on the dev machine (not committed).
> Access: `ssh -i ~/.ssh/github_virphone ubuntu@40.160.11.123`.

This deploys the current single-tenant backend (the real, working product)
to an OVH VPS or Public Cloud instance with automatic HTTPS. The desktop
app then connects over the network. Multi-tenant SaaS (auth, billing,
workers) is future work — see CLOUD_ARCHITECTURE.md.

## What you need

- OVH VPS or Public Cloud instance, Ubuntu 22.04+ (2 vCPU / 4 GB RAM is
  plenty for the backend; add a GPU instance only if self-hosting models)
- A domain with an A record pointed at the instance IP
  (e.g. `orvyn.yourdomain.com`)
- Ports 80 and 443 open in the OVH firewall / security group

## Steps

1. **SSH in and install Docker:**

```bash
curl -fsSL https://get.docker.com | sh
sudo apt-get install -y docker-compose-plugin
```

2. **Get the repo onto the server** (git clone or rsync) and `cd` into it.

3. **Configure environment:**

```bash
cp .env.example .env
openssl rand -hex 32        # → ORVYN_API_KEY in .env
# set DOMAIN=orvyn.yourdomain.com
# set at least one model provider (MODEL_API_KEY / DEEPSEEK_API_KEY /
#   CHEAPER_INFERENCE_API_KEY) and optionally ASTRA_MODEL_ID
```

Never commit `.env`. On OVH you can alternatively inject env vars via
cloud-init or your orchestration tooling.

4. **Launch:**

```bash
docker compose up -d --build
```

Services: `backend` (Node 20, multi-stage image, no dev deps),
`caddy` (TLS termination, automatic Let's Encrypt), optional `ollama`
(self-hosted models; comment out if unused).

5. **Verify:**

```bash
curl https://orvyn.yourdomain.com/api/v1/health
# {"status":"ok","service":"orvyn-backend",...}
```

6. **Point the desktop app** at `https://orvyn.yourdomain.com` + the API
   key in Settings → Connection → Test Connection → Save.

## Health checks

- `GET /api/v1/health` — liveness (no auth). Wire this into OVH monitoring
  or any uptime checker.
- `docker compose ps` / `docker compose logs -f backend` — service state
  and structured request logs.

## Logging

Backend logs to stdout; Docker captures them (`docker compose logs`).
For retention, add a `logging` driver (json-file with rotation, or
forward to your aggregator):

```yaml
    logging:
      driver: json-file
      options: { max-size: "50m", max-file: "5" }
```

## Backups

Current state worth backing up:

- `.env` (secrets — store a copy in a password manager, not in git)
- Any project `.orvyn/` directories on the server (checkpoints, rules)
- `caddy-data` volume (certificates; re-issuable, but backup avoids
  rate-limit pain): `docker run --rm -v viride_caddy-data:/d -v $PWD:/b
  alpine tar czf /b/caddy-data.tgz /d`

When PostgreSQL lands (cloud tier), nightly `pg_dump` to OVH Object
Storage becomes the primary backup.

## Updating

From a machine that can SSH to the box (this Cloud Agent already can):

```bash
./scripts/deploy-ovh.sh
```

That rsyncs `apps/backend`, `apps/worker`, `packages`, and `infrastructure`
and rebuilds only `backend` + `worker`. The server `.env` and named volumes
(Postgres, Redis, Qdrant, Caddy) are not overwritten.

GitHub Actions job **Deploy OVH control plane** runs the same script after
CI on push to `main` or `fix/core-agent-runtime` when the repository secret
`OVH_SSH_PRIVATE_KEY` is set.

Manual on the server:

```bash
# after code is already on the box
docker compose \
  -f docker-compose.yml \
  -f infrastructure/ovh/compose.prod.yml \
  -f infrastructure/ovh/compose.control-plane.yml \
  -f infrastructure/ovh/compose.worker.yml \
  up -d --build backend worker
```

## Scaling later

Single instance is the supported topology today. The cloud tier
(CLOUD_ARCHITECTURE.md) introduces managed PostgreSQL + Redis, separate
worker hosts, and a load balancer — do not attempt to run multiple
backend replicas behind one domain with the current in-memory state.
