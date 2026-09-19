# Security Model

## Electron hardening (`apps/desktop/src/main/main.ts`)

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- Renderer has no Node access; the preload bridge exposes only
  `project.open / listDirectory / readFile / writeFile` over validated IPC
- No remote code, no eval, frameless window with custom TitleBar

## Backend authentication

- **Per-user accounts** (`/api/v1/auth/*`): register/login with email +
  password. Passwords are scrypt-hashed (N=16384, per-user salt); session
  tokens are 32 random bytes shown once and stored only as sha256, expiring
  after 30 days; login is rate-limited (5 failures / 15 min per email).
  A session token authenticates every route and the WS stream, and resolves
  to that user's own isolated tenant (own models, tools, missions, SQLite
  store at `user_<id>.db`). Accounts live in a shared `auth.db`.
- `ORVYN_API_KEY` still works as a shared key for single-tenant installs
  (Bearer header; the WS chat stream uses `?token=`). Unset = local
  unauthenticated single-tenant — the server prints a warning.
- Provider API keys live in backend env / model registry only. They are
  never serialized to the renderer.

## Agent containment

Layered, and every layer is enforced server-side:

1. **Project sandbox** — file, terminal, git, and process tools resolve
   paths against the project root; escapes (`..`, absolute paths outside
   the root) are rejected in `resolveSafe`.
2. **Capability flags** — READ, WRITE, DELETE, EXECUTE, NETWORK, GIT,
   DATABASE, DEPLOYMENT, SYSTEM. Each tool declares requirements; each
   agent role holds a fixed set (Permission Engine). Astra cannot write
   files; the research agent cannot execute commands.
3. **User policy** — per-tool `allowed | ask | denied`, composed with the
   autonomy profile (SAFE / BALANCED / AUTONOMOUS, see
   `docs/TOOL_GATEWAY.md`). Destructive terminal commands (rm/del/format/…)
   always require approval — no profile or per-tool setting can pre-approve
   them. Denied tools return a typed refusal to the model.
4. **Approvals** — `ask` pauses the run and emits `approval.required`;
   nothing executes until the user answers. Approvals are per-call.
5. **Network guards** — `fetch_url` blocks private/loopback IP ranges;
   `web_search` uses public search APIs only.
6. **Checkpoints** — snapshots before autonomous write batches; restore /
   compare / delete via API and the SCM panel. Never auto-push.

## What agents can never do

- Bypass the Tool Gateway (no direct fs/child_process imports in agent
  code paths; tools are the only effectors offered to models)
- Read or write outside the opened project root
- Push to a remote, deploy, or touch databases (DEPLOYMENT/DATABASE
  capabilities are denied for all roles — no tools exist yet)
- Access provider credentials or ORVYN's own configuration secrets

## Known gaps (tracked in the audit)

- Accounts have no email verification, password reset, or OAuth yet, and
  there are no organizations/RBAC — one user = one tenant (cloud tier work)
- No general request rate limiting (login attempts are rate-limited)
- Terminal executes on the host (per-approval, sandboxed to project paths,
  but not containerized). Cloud mode will run agents in isolated Docker
  workers instead
- Approvals support two scopes: "Allow Once" (per-call) and "Allow for
  Mission" (the tool is auto-approved for the rest of that run only).
  Destructive shell commands are excluded — they always re-prompt, even
  after a mission-scope approval. SAFE / BALANCED / AUTONOMOUS profiles are
  implemented (Settings → Autonomy profile) and persist across restarts
- Model configs persisted to the local SQLite store include provider API
  keys in plaintext (same trust level as `.env` on the same disk). The
  cloud tier must encrypt provider credentials at rest
