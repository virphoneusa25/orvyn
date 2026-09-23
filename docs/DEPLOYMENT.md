# Deploying ORVYN: cloud backend + Windows desktop client

This is the real path from "runs on my laptop" to "backend on a cloud
server, IDE installed on Windows machines pointing at it" — the same
shape as Cursor's client/server split, except you own every layer.

```
Windows PC(s)                     Your cloud server
┌───────────────────┐             ┌───────────────────────────────┐
│ ORVYN.exe         │  HTTPS/WSS │ Caddy (TLS termination)        │
│ (Electron desktop) │ ─────────► │   └─ ORVYN backend (Docker)   │
│                    │            │        └─ Model Gateway         │
└───────────────────┘             │             └─ Ollama/vLLM/etc  │
                                   └───────────────────────────────┘
```

## Part 1 — Backend on a cloud server

Any Linux VM with Docker works: a $6-12/mo box on DigitalOcean/Vultr/
Hetzner is plenty for the backend itself; add a GPU instance (AWS/Azure/
Lambda/RunPod/etc) only if you're also self-hosting the model there.

1. **Provision a server** and point a DNS A record at its IP, e.g.
   `orvyn.yourdomain.com`. Open ports 80 and 443 (443 for HTTPS, 80 only
   for the Let's Encrypt challenge).

2. **Install Docker + Docker Compose** on the server (`curl -fsSL
   https://get.docker.com | sh` on most distros, then `apt install
   docker-compose-plugin` or equivalent).

3. **Copy this repo to the server** (`git clone`/`scp`/`rsync` — whatever
   you'd normally use) and `cd` into it.

4. **Configure secrets:**
   ```bash
   cp .env.example .env
   # generate a real key:
   openssl rand -hex 32
   # put it in .env as ORVYN_API_KEY=<the generated value>
   # set DOMAIN=orvyn.yourdomain.com in .env
   ```

5. **Start everything:**
   ```bash
   docker compose up -d --build
   ```
   This builds the backend image (see `apps/backend/Dockerfile`), starts
   an Ollama container for self-hosted models, and starts Caddy, which
   automatically requests and renews a Let's Encrypt certificate for
   `DOMAIN` — no manual certbot steps.

6. **Verify:**
   ```bash
   curl https://orvyn.yourdomain.com/api/v1/health
   # {"status":"ok","service":"orvyn-backend","version":"0.1.0"}
   ```

7. **(Optional) Pull a real model into the self-hosted Ollama container:**
   ```bash
   docker compose exec ollama ollama pull llama3
   ```
   Then register it the same way you would locally — either
   `POST /api/v1/models` with `"endpoint": "http://ollama:11434"` (the
   Docker Compose service name, reachable from the backend container), or
   edit `.orvyn/models.json` in the project you open. See
   `apps/desktop` README section "Model Manager" for the exact fields.

### What's already handled for you here
- **HTTPS** — Caddy does this automatically; you never touch a certificate.
- **Auth** — every route except `/health` requires `ORVYN_API_KEY`
  (verified working: wrong/missing key → 401, correct key → 200, and the
  WebSocket chat stream is gated by the same key via a `?token=` param).
- **Project isolation** — every file/terminal/git tool is sandboxed to the
  project root passed in per-request; nothing can read outside it.

### What is NOT handled yet (be aware before going further)
- **Single shared API key, not per-user accounts.** Anyone with the key
  has full access — fine for you alone or a small trusted team behind a
  shared secret, not fine for a multi-tenant product. Real auth/RBAC
  (master spec section 22/35) is Phase 7, not built yet.
- **No rate limiting.** Add one at the Caddy layer or in Express before
  exposing this to more than a few known users.
- **In-memory state.** Model configs, agent sessions, and the codebase
  index all live in the backend process's memory — they're lost on
  restart, and don't scale past one backend instance. Fine for one
  person/small team on one server; needs Postgres + a real job queue
  (master spec section 19) before it's a multi-instance production
  service.
- **Terminal tool runs real shell commands on your server.** It requires
  approval per the Agent permission model, but there's no per-user
  sandboxing (containers-per-session, etc.) — don't hand the API key to
  anyone you wouldn't give shell access to that box.

If you want this hardened further (rate limiting, per-user auth, sandboxed
command execution, Postgres-backed persistence), that's a concrete next
phase I can build — just say so.

## Part 2 — Windows desktop client

The Electron app is identical whether it talks to `localhost` or your
cloud server — only the Connection settings change.

### Building the Windows installer

This has to be built on (or cross-compiled for) Windows — `electron-builder`
can cross-compile from Linux/macOS with Wine installed, but building
natively on Windows is simpler and what most people do:

```bash
# On a Windows machine, or CI runner with Node 18+:
git clone <this repo>
cd orvyn
npm install
npm run dist:win -w apps/desktop
```

This produces `apps/desktop/release/ORVYN-Setup-<short-sha>.exe`.
Distribute that `.exe` to any Windows machine —
double-click to install, no admin rights required beyond the standard
Windows install prompt (`"oneClick": false` in the build config means the
user picks the install directory, matching normal Windows installer UX).

### Pointing it at your cloud server

After installing and opening ORVYN:

1. Click the ⚙️ **Connection** icon in the Activity Bar.
2. Set **Backend URL** to `https://orvyn.yourdomain.com` (no trailing
   slash, no `/api/v1` suffix — the app adds that).
3. Set **API Key** to the same `ORVYN_API_KEY` value from your server's
   `.env`.
4. Click **Test Connection** — it should show `✓ Connected — orvyn-backend
   v0.1.0`.
5. Click **Save**. This is persisted to disk (`orvyn-connection.json` in
   the app's user-data folder) so it survives restarts — every panel
   (Chat, Composer, Agent, Search, Model Manager) automatically uses this
   connection from then on.

From here it behaves exactly like the local setup: Open Folder picks a
directory **on the Windows machine** (file/terminal/git tools operate on
your local project), while the AI reasoning, model gateway, and codebase
index live on your cloud server.

### Multiple machines / a small team

Every teammate installs the same `.exe`, points it at the same
`https://orvyn.yourdomain.com` with the same API key, and gets the same
backend and configured models — a real shared setup, with the caveat
above that it's currently one shared key rather than individual accounts.
