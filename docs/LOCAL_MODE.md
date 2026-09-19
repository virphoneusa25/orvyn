# Local Mode

Local mode is the product today. Everything runs on the user's machine;
no project files leave it except the targeted context sent to whichever
model providers the user configured.

```
ORVYN Desktop (Electron)
   ↓ localhost HTTP/SSE/WS
ORVYN Backend (node, port 4570)
   ↓
Agents → Tool Gateway → the user's project directory
   ↓
Model providers of the user's choice (Ollama = fully local,
or OpenAI / DeepSeek / Cheaper Inference via their APIs)
```

## Guarantees

- The project stays on disk; tools operate in-place inside the project
  root only.
- The user owns permissions: per-tool `allowed/ask/denied`, approval
  prompts for writes/exec/network/git by default.
- Checkpoints (`.orvyn/checkpoints/`) make every autonomous change
  recoverable; the SCM panel exposes restore/compare.
- Fully offline operation is possible with Ollama models — the Model
  Gateway treats local and remote providers identically.
- Provider keys are stored in backend env (`.env`) — never in the
  renderer, never in the project.
- State survives restarts: missions, usage events, the autonomy profile,
  per-project tool overrides, and user-added models persist to a per-tenant
  SQLite database at `~/.orvyn/data/<tenant>.db` (`ORVYN_DATA_DIR`
  overrides the location; built on node:sqlite, so no native deps).
- Accounts are optional in local mode: without signing in you use the
  shared "default" tenant. Signing in (Settings → Account) gives you an
  isolated per-user tenant — required for shared or cloud deployments.
  See docs/SECURITY.md for the auth design.

## Running

```bash
npm install
npm run backend:dev     # Express on :4570
npm run desktop:dev     # Electron + Vite
```

Or point the desktop's Connection settings at a remote backend you host
(see DEPLOYMENT.md / OVH_DEPLOYMENT.md) — same client, same API.

## Project-level config (`.orvyn/` in the opened project)

- `rules.md` — instructions injected into every AI request
- `config.json` — tool permission defaults
- `models.json` — extra model registrations
- `mcp.json` — MCP servers for this project
- `checkpoints/` — snapshot storage
