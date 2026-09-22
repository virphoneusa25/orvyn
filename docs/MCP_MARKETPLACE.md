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

- `stdio` servers run on the same machine as their files/runtimes.
- Streamable HTTP can be invoked remotely when authenticated.
- Cloud ORION cannot assume a desktop stdio process is reachable.
- A future ORVYN-managed MCP Gateway is reserved; not required for this
  milestone.

## UI

**Tools & MCP → Marketplace**

Search, categories, Installed, Updates, Private registries, import/export
(Cursor / Claude Desktop / VS Code JSON, secrets stripped).

Composer **+** menu: **Add MCP capability**.

Context popover reports MCP tool schema tokens separately from native tools.

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
