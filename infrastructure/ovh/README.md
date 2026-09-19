# OVH deployment assets

Full walkthrough: **`docs/OVH_DEPLOYMENT.md`**.

| File | Purpose |
|---|---|
| `compose.prod.yml` | Production overrides for the root `docker-compose.yml`: healthcheck on `/api/v1/health`, log rotation, `restart: always` |
| `backup.sh` | Backs up the Caddy certificate volume and `.env`; extend with `pg_dump` when PostgreSQL lands |
| `../docker/Caddyfile` | TLS termination + reverse proxy (automatic Let's Encrypt from `$DOMAIN`) |
| `../../apps/backend/Dockerfile` | Multi-stage backend image (Node 20 slim, no dev deps) |
| `../../.env.example` | Environment template — copy to `.env`, never commit the real one |

Launch:

```bash
docker compose -f docker-compose.yml -f infrastructure/ovh/compose.prod.yml up -d --build
```

Monitoring: wire `https://$DOMAIN/api/v1/health` into OVH monitoring or
any uptime checker (no auth required on that route). Container-level
health is visible in `docker compose ps` via the healthcheck.
