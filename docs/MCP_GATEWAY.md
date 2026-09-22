# Cloud MCP Gateway

OVH ORION runs cannot reach a Windows-local stdio process. The Cloud MCP
Gateway is the only path from a cloud run to an approved MCP connection.

```
ORION Cloud Runtime
  → MCP Gateway (control plane)
    → approved remote Streamable HTTP MCP
```

Local stdio stays on the desktop and is labeled **Local Only**. The gateway
refuses `cloudRun + executionLocation=local` with a truthful error. There is
no hidden local fallback.

## What the gateway mediates

- Tenant identity (`tenantId` must match the caller’s tenant)
- Server identity
- Tool name
- Enterprise policy (allow/block/admin deny)
- Project/run scope
- Secrets (resolved server-side)
- Timeouts (`ORVYN_MCP_CALL_TIMEOUT_MS`, default 120s)
- Circuit breaker / health
- Audit (sanitized)

## Auth

`POST /mcp/gateway/invoke` uses the same authenticated ORVYN tenant identity as
the rest of `/mcp/*`. Worker credentials are separate (`assertWorkerCredential`)
and never carry user OAuth tokens. The model loop stays on the control plane;
the worker only prepares the mission container and serves filesystem/terminal
RPC.

## Routing

`ToolGateway` remains the only permission system. Namespaced tools
`mcp.<server>.<tool>` execute through `McpManager` locally, or through
`McpCloudGateway.invoke` when the run’s `execution.location` is `OVH_WORKER`.

| Server location | Desktop run | OVH run |
|---|---|---|
| `local` (stdio) | ToolGateway → local process | **Rejected — Local Only** |
| `remote` (HTTP) | ToolGateway → remote MCP | Gateway → remote MCP |
| `cloud` | reserved cloud MCP runtime | Gateway → cloud MCP runtime |

## Outage

If the gateway is marked unavailable, cloud MCP calls fail with
“MCP Gateway unavailable… There is no local fallback.” ORION must report that
truthfully.

## Health

`GET /mcp/gateway/health` reports gateway online/unavailable, connected server
count, and failing servers (error, offline, or circuit open).
