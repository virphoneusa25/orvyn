# OVH deployment assets

Full walkthrough: **`docs/OVH_DEPLOYMENT.md`**.

| File | Purpose |
|---|---|
| `compose.prod.yml` | Production overrides for the root `docker-compose.yml`: healthcheck on `/api/v1/health`, log rotation, `restart: always` |
| `backup.sh` | Backs up the Caddy certificate volume and `.env`; extend with `pg_dump` when PostgreSQL lands |
| `../docker/Caddyfile` | TLS termination + reverse proxy (automatic Let's Encrypt from `$DOMAIN`) |
| `../../apps/backend/Dockerfile` | Multi-stage backend image (Node 20 slim, no dev deps) |
| `../../.env.example` | Environment template — copy to `.env`, never commit the real one |

Staging (isolated control plane, does not share DB/Redis/volumes with production):

```bash
bash scripts/deploy-ovh-staging.sh
# https://staging.orvyn.virphoneusa.com/api/v1/health
```

DNS A record `staging.orvyn.virphoneusa.com` → `40.160.11.123` is live; Caddy terminates TLS with Let's Encrypt. Secrets live in server-side `.env.staging`.

Launch:

```bash
docker compose -f docker-compose.yml -f infrastructure/ovh/compose.prod.yml up -d --build
```

Monitoring: wire `https://$DOMAIN/api/v1/health` into OVH monitoring or
any uptime checker (no auth required on that route). Container-level
health is visible in `docker compose ps` via the healthcheck.
