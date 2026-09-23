# MCP Marketplace

ORVYN federates existing MCP registries so you can discover, inspect, install,
connect, enable, disable, update, and remove servers without hand-writing
config. This layer sits **on top of** the existing MCP Host — it does not
replace `McpClient`, `McpManager`, `McpRegistry`, `McpPermissionService`,
`McpToolAdapter`, or ToolGateway.

## Architecture

```
Marketplace Catalog
  → Capability Index
  → Semantic Tool Discovery (search_capabilities)
  → Selected MCP Server
  → Tool Introspection (tools/list)
  → Permission Check
  → ToolGateway
  → ORION
```

Thousands of servers can be searchable. ORION never receives the catalog.
It gets one discovery tool (`search_capabilities`) and a small budget of
activated `mcp.<server>.<tool>` schemas (default: 8 servers / 40 tools).

## Providers

| id | Source | Required? |
|---|---|---|
| `official` | Official MCP Registry (`registry.modelcontextprotocol.io`) | No — cached/local results remain if it is down |
| `glama` | Glama directory (`GLAMA_API_KEY`) | No — returns `needs-key` without a key |
| `local` | Servers already in McpManager | Always |
| `private` | User-added Official-API-compatible registries | Optional |

`RegistryAggregator` queries providers in parallel, normalizes, deduplicates
by repository / package / name, ranks (keyword + hashing-embedder semantic),
and caches results for 5 minutes.

Air-gapped / enterprise: disable public providers and keep only `private` +
`local`. There is no hard dependency on any public API.

## Trust

- **Verified** — listed in `verifiedCatalog.ts` after defined checks
  (publisher, official listing, known repository). Not a lifetime security
  guarantee.
- **Community** — Official Registry and/or recognized publisher, or
  locally/privately added.
- **Unverified** — third-party directory only (e.g. Glama-only).
- **Blocked** — ORVYN / admin / user blocklist.

Glama quality scores are shown as *attributed source metadata*, never as
ORVYN's own safety rating.

## Installation

The install wizard: Review → Permissions → Authentication → Install → Test.

- npm / PyPI / uvx / Docker / binary / Streamable HTTP.
- Versions are **pinned** (`pkg@version`). No silent auto-upgrade.
- Secrets are stored via the existing `mcp.secret.*` store and referenced
  as `{{name}}` in config. Never localStorage, logs, or plain config.
- Local stdio processes start in `~/.orvyn/data/mcp-runtime/<server>` unless
  the server is project-scoped (workspace path only).
- One crashing server cannot crash ORVYN. Connect timeout and local process
  budget apply.
- Installation is always a user action. ORION may *recommend* a server; it
  must not install executables itself.

Created config is a normal `McpManager` record, so restart reconnects
enabled servers through `startEnabled()`.

`registerProjectToolsFor` clears the tool registry at the start of every
ORION run (so native tools rebind to the current project). After native
registration it calls `McpManager.reregisterConnectedTools()` so already-
connected marketplace servers keep their `mcp.<server>.<tool>` gateway
entries. Connections are not restarted.

## Dynamic discovery

ORION calls `search_capabilities({ query: "create GitHub PR" })`.

1. Search the local capability index (installed tool names + descriptions).
2. If a matching installed tool exists and policy allows it, activate its
   schema for the next turn.
3. Otherwise return marketplace candidates and ask the user to install,
   with a concrete reason (“ORION needs Jira to create the requested issue”).

Ask mode still requires approval for write/destructive MCP tools. Full
Access cannot bypass hard policy.

## Local vs cloud

- `stdio` servers run on the same machine as their files/runtimes and are marked **Local Only**.
- Streamable HTTP is `remote` and can be invoked from OVH ORION through the Cloud MCP Gateway.
- Cloud ORION never pretends a Windows-local stdio process is reachable. There is no hidden local fallback.
- See `docs/MCP_GATEWAY.md` and `docs/MCP_SECURITY.md`.

## UI

**Tools & MCP → Marketplace** is a two-pane IDE workspace (not a modal):

- **Left (~65–72%)** — selected server: icon, publisher, install/connect/disable/uninstall, then Details / Tools / Permissions / Configuration / Security / Source.
- **Right (~320–420px, resizable)** — sticky search, filters, then collapsible Installed / Recommended / Discover / Updates. Discover is used instead of Popular because registries do not expose trustworthy ratings.

Search still federates Official + Glama + local + private. Install reuses the Review → Permissions → Auth → Confirm drawer over the detail pane. `orvyn:marketplace-open` deep-links a capability query into the right-hand search.

Server icons use published registry artwork when present, otherwise the product mark (GitHub, PostgreSQL, Slack, Docker, …) or the publisher’s GitHub avatar. Initials are only the fallback. If a Cloud backend returns HTML, 404, or an empty catalog for `/mcp/marketplace`, the desktop federates the Official MCP Registry directly (`registry.modelcontextprotocol.io`) so Discover / Recommended still show real servers and logos. Install then uses `/mcp/marketplace/install` when present, or `/mcp/servers` on older control planes.

Composer **+** menu: **Add MCP capability**. Built-in ORVYN tools stay on their own tab.

## API

- `GET /mcp/marketplace/search?q=&limit=&category=`
- `GET /mcp/marketplace/health`
- `GET /mcp/marketplace/featured`
- `GET /mcp/marketplace/categories`
- `GET /mcp/marketplace/updates`
- `POST /mcp/marketplace/install`
- `GET|POST /mcp/marketplace/registries`
- `GET /mcp/marketplace/export`
- `POST /mcp/marketplace/import`

Existing `/mcp/servers`, `/mcp/test`, `/mcp/statuses` remain the host API.

Production hardening endpoints:

- `POST /mcp/oauth/start` — Authorization Code + PKCE, loopback callback
- `GET /mcp/oauth/status`
- `POST /mcp/oauth/disconnect/:id` — clear token refs, best-effort revoke (does not uninstall)
- `POST /mcp/oauth/refresh/:id`
- `POST /mcp/gateway/invoke` — tenant-bound Cloud MCP Gateway
- `GET /mcp/gateway/health`
- `GET|PUT /mcp/policy` — Open / Verified Only / Allowlist Only
- `GET /mcp/health` — Healthy / Slow / Needs Auth / Offline / Error / Disabled / Blocked
- `PATCH /mcp/servers/:id/scope` — Global / This Project / This Run
- `POST /mcp/servers/:id/block`
- `POST /mcp/servers/:id/sandbox` — initialize + tools/resources/prompts list only
- `GET /mcp/provenance` · `POST /mcp/inspect` · `GET /mcp/audit`
- `GET /mcp/capabilities/diagnostics` — activated schemas + token footprint

## OAuth

When `auth.kind === oauth`, Installed shows **Connect account**. ORVYN discovers standard
OAuth metadata, opens the system browser, binds a short-lived `127.0.0.1` loopback,
validates `state`, exchanges the code with PKCE S256, and stores access/refresh/expiry
in the existing `mcp.secret.*` store. Tokens are refreshed before expiry; refresh
failure becomes **Needs Auth** with a 60s backoff. Disconnect clears refs and tries
revocation. The server stays installed.

## Scoping

- **Global** — every project for this account (e.g. GitHub).
- **This Project** — only the selected workspace (e.g. a project database).
- **This Run** — ephemeral; deactivated when the ORION run settles.

Discovery respects tenant, user, project, and run. Inaccessible tools are not shown to ORION.

## Enterprise policy

Modes: **Open**, **Verified Only**, **Allowlist Only**. Blocklists cover canonical id,
package, publisher, tool, and registry source. Admin tool deny is a hard deny and
overrides Full Access. Organization-approved servers can be listed on the allowlist.

## Health

Installed shows Healthy / Slow / Needs Auth / Offline / Error / Disabled / Blocked,
plus latency, restart count, and circuit-open reason. Local crashes retry with
bounded backoff (1s / 4s / 16s, max 3). Five failures in 60s open a 30s circuit.

## Capability recommendations

`search_capabilities` still activates only matching installed tools within the
8-server / 40-tool budget. If nothing is installed, ORION emits `capability.required`
(`query`, `reason`, `recommendedServers`, `runId`). Chat shows Connect / View options /
Cancel. ORION never silently installs executables.

Ranking uses task relevance, installed status, scope, health, trust, and recent
successful use. Run replay stores `mcp.activation` (activated servers/tools, reason,
schema token footprint).
