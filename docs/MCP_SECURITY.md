# MCP Security

How ORVYN hardens MCP for desktop, cloud, OVH worker runs, personal accounts,
and future teams.

## Credentials

- OAuth and API tokens live in the `mcp.secret.*` store (the same seam as
  marketplace secrets). Config holds `{{name}}` references only.
- Never localStorage, plaintext config, logs, or model/worker payloads.
- Workers and models do not receive raw MCP credentials. The Cloud MCP Gateway
  resolves secrets on the control plane.

## OAuth

- Authorization Code + PKCE S256. Implicit flow is not used.
- `state` is a 24-byte random value; callbacks that do not match are rejected.
- Loopback listener binds `127.0.0.1` on an ephemeral port and closes after the
  first request or 120 seconds — it is never left open indefinitely.
- Refresh runs automatically within 60s of expiry. Failure marks **Needs Auth**
  and backs off for 60s so a broken provider is not hammered.
- Disconnect clears token references and attempts RFC 7009 revocation when the
  server advertises a revocation endpoint. The server is not uninstalled.

## Provenance

Every executable install records, when available:

package, version, registry, publisher, repository, integrity/checksum,
install source, installedAt, install scripts.

- Versions must be pinned (`x.y.z`). `latest`, `*`, `^`, and `~` are refused.
- `preinstall` / `install` / `postinstall` are surfaced as a warning, not hidden.
- Integrity hashes from npm `dist.integrity` / `shasum` are stored.
- If the listing claims a repository that does not match published metadata,
  ORVYN flags a mismatch. Heuristics are signals, not a malware verdict.

## Sandbox probe

Unverified local stdio servers are probed with `initialize`, `tools/list`,
`resources/list`, and `prompts/list` only. The probe does not enable the server
and must not perform write side effects.

## Blocked

A server can be **Blocked** with a reason. Blocked servers cannot start even if
they were previously installed.

## Policy

| Mode | Who can start |
|---|---|
| Open | Anyone except explicit blocklist |
| Verified Only | ORVYN Verified or organization-approved |
| Allowlist Only | Allowlist or organization-approved |

Admin-denied tools cannot run even when the user is on Full Access. That check
lives in `McpManager`’s tool guard, on the same ToolGateway path as every other
MCP call.

## Audit

Install, enable, disable, update, connect, disconnect, tool invocation,
approval, and denial are appended to `mcp.audit.v1`. Secret-shaped keys are
replaced with `[redacted]`.

## Tenant isolation

Each tenant has its own `McpManager`. Gateway invokes additionally require
`tenantId === expectedTenantId`. Tenant B cannot see or invoke Tenant A’s
connections.
