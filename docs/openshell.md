# OpenShell execution sandboxes (internal)

ORVYN can run a cloud mission's commands inside an NVIDIA OpenShell sandbox
instead of the plain Docker mission container. OpenShell is **only the
execution layer**. ORION's model loop, tools, permissions, verification,
tenancy, billing and the portal are unchanged, and OpenShell is not a control
plane: the backend decides everything and the worker obeys.

Status: **Stage 1 (built, tested locally against a real 0.1.2 gateway).
Disabled by default.** Docker stays the default for every organization.

Never name the runtime, the sandbox vendor or the hosting provider in
customer-facing text. Customer events say "workspace", "network access",
"sandbox"; provider names appear only in the admin portal.

## Pinned versions

| Piece | Version | Where |
|---|---|---|
| Gateway | `ghcr.io/nvidia/openshell/gateway:0.1.2` | `infrastructure/ovh/compose.openshell.yml` |
| Supervisor / sandbox runtime | `ghcr.io/nvidia/openshell/{supervisor,sandbox}:0.1.2` | `infrastructure/openshell/gateway.toml` |
| TypeScript SDK | `@nvidia/openshell-sdk` 0.1.2, built from tag `v0.1.2` (commit `6648bd0c`) | `apps/worker/vendor/nvidia-openshell-sdk-0.1.2.tgz` (sha256 `ddd80075…76f5`) |
| SDK deps | `@bufbuild/protobuf` 2.12.1, `@connectrpc/connect(-node)` 2.1.2 | `apps/worker/package.json` (exact) |
| CLI (admin only) | `openshell_0.1.2-1_amd64.deb`, sha256 `1f5416ea…23df` | `infrastructure/openshell/setup.sh` |
| Workload image | `orvyn/sandbox:0.1.2-1` (Ubuntu 24.04, node 20.19.5, git, curl, python 3.12, ssh; user `sandbox` uid 1000) | `infrastructure/openshell/sandbox-image/Dockerfile` |

The SDK is vendored because GitHub Packages needs a token even for public
packages. `setup.sh` records the image digests in `/var/lib/openshell-digests.txt`.
Upgrades are a deliberate change to these pins plus a full acceptance run.

## How a mission runs

```
portal / desktop ─► backend (control plane) ─► job queue ─► worker ─► ExecutionSandboxProvider ─► gateway ─► sandbox
                     model loop, tools,          (in memory;    │         docker | openshell        (mTLS,
                     permissions, billing        Redis later)   │                                    private)
                                                                └─ tool RPC (/worker/tools/:run/next|result)
```

1. `queueExecutorJob` (routes/worker.ts) calls `selectSandbox` and writes the
   registry row **before** any worker sees the job. The plan carries provider,
   fallback, policy template (always `code-basic`), plan-tier resources,
   retention and the ORVYN sandbox id.
2. The worker stages the durable workspace (ORVYN storage stays the source of
   truth), hands the files to uid 1000 for OpenShell, then `runtime.acquire()`
   creates or **reattaches** the sandbox. Only that run's directory is mounted,
   at `/workspace`.
3. Every tool call arrives over the existing RPC channel. File tools run on the
   worker against the same bytes (symlinks out of the workspace are refused);
   commands run through `provider.exec()` with the plan's per-command timeout.
4. At the end the worker syncs changed files back to the durable workspace,
   then destroys the sandbox (ephemeral) or keeps it (retained).

## Code map

| Concern | File |
|---|---|
| Interface, states, `ExecResult`, capabilities, failure kinds | `apps/worker/src/sandbox/types.ts` |
| Docker provider (existing hardening, plan limits, real exit codes, in-container timeout) | `apps/worker/src/sandbox/docker.ts` |
| OpenShell provider | `apps/worker/src/sandbox/openshell.ts` |
| Selection on the worker, fallback, reconnect, metrics, reconciliation | `apps/worker/src/sandbox/runtime.ts` |
| Policy templates (versioned) + validator/renderer | `apps/worker/sandbox-policies/*.v1.json`, `apps/worker/src/sandbox/policies.ts` |
| Registry, flags, audit, policy requests (SQLite `execution.sqlite`) | `apps/backend/src/execution/sandbox/SandboxRegistry.ts` |
| Provider selection, canary, plan tiers, retention | `apps/backend/src/execution/sandbox/selection.ts` |
| Network-access requests, credential brokering rules | `apps/backend/src/execution/sandbox/policyRequests.ts` |
| Worker endpoints (report, live, reconciled, policy applied, credentials), recovery loop | `apps/backend/src/routes/worker.ts` |
| `request_network_access` tool | `apps/backend/src/agent/StreamingAgentRuntime.ts` (`mountNetworkAccessTool`) |
| Owner approval | `GET/POST /api/v1/account/network-requests`, bell notification |
| Admin | `/admin/runtime`, `PUT /admin/runtime/flags`, `POST /admin/runtime/requests/:id`, `/admin/customers/:id/sandboxes`, System Health rows |

## Isolation model (OpenShell)

- **One OpenShell workspace per ORVYN organization** (`orv-<15 hex of sha256(org)>`).
  The gateway refuses sandbox lookups, exec, attach and provider access across
  workspaces.
- **Workspace mount**: a Docker volume `orvyn-ws-<sandbox>` that is a bind of
  exactly that run's directory, labeled
  `openshell.ai/sandbox-attachable-workspace=<org workspace>`. Resource
  admission stays **on**, so the gateway refuses to mount it into any other
  organization's sandbox (tested). Raw bind mounts are never used.
- **Process**: non-root uid 1000, all capabilities dropped, `no_new_privs`,
  Landlock filesystem policy (write only `/workspace`, `/tmp`), pids limit,
  CPU/memory limits from the plan, no restart policy.
- **Network**: deny by default. Unapproved names resolve to synthetic
  `198.18.x.x` addresses and the connect is refused; loopback, link-local and
  metadata addresses are always blocked. Rules are per binary (real paths in
  the workload image).
- **Credentials**: brokered per organization + integration, stored in the
  gateway, injected as placeholders resolved by the proxy only toward the
  endpoints the profile allows. The value never enters the sandbox.

## Policy templates

Source of truth: `apps/worker/sandbox-policies/<id>.v<N>.json` (OpenShell
proto-JSON). The loader refuses a template that grants writes outside
`/workspace`/`/tmp`, runs as root, uses audit mode on inspected endpoints,
uses `allowed_ips`, a hostless endpoint, a too-broad wildcard, or a rule
without binaries.

| Template | Allows | Plans |
|---|---|---|
| `code-basic` | nothing (every mission starts here) | all |
| `web-development` | npm/yarn/PyPI registries + static CDNs, read-only, node/python only | all |
| `research` | reference documentation sites, read-only | Starter+ |
| `github` | GitHub clone/fetch/push + registries; credential via `orvyn-github` profile | Starter+ |
| `deployment` | registries, GitHub, Vercel/Netlify/Cloudflare APIs | Pro+ |
| `server-admin` | SSH (22) to hosts the owner approved; public hosts only | Business+ |

Expansion: the model calls `request_network_access` → pending request →
owner/admin approves in the bell (or staff in the customer's Sandboxes tab) →
the worker gets the update with its next tool poll, attaches credentials
first, sets the new policy and waits until the sandbox reports it **loaded**.
The requester can never decide its own request. Filesystem, Landlock and
process settings never change after creation.

## Failure classes

| Class | Source | Runtime behaviour |
|---|---|---|
| tool bad args | worker validation | model corrects the call (same model) |
| tool internal | provider/config error | tool fails with the reason |
| sandbox unavailable | gateway down, sandbox gone | one reconnect; `auto` falls back to Docker at create time; `SANDBOX_UNAVAILABLE` → `CAPABILITY_UNAVAILABLE` |
| network policy denial | classified from the refusal | `NETWORK_POLICY_DENIED` → `PERMISSION_DENIED`; the model is told not to retry and may request access |
| credential policy denial | cross-org grant, missing credential | `CREDENTIAL_POLICY_DENIED` → `PERMISSION_DENIED` |
| provider/model failure | model API | the only class that fails over to another model |

Model failover never touches the sandbox (it is bound to the run id), so a
model switch continues on the same sandbox and bytes.

## Recovery

- **Worker restart**: sandboxes outlive the worker process. The control plane
  marks a worker offline after 45 s without heartbeat and re-queues its active
  jobs with `recover: true`; tool calls it had already taken fail with a clear
  message, queued ones wait. The next worker keeps the workspace bytes on the
  host and reattaches (`sandbox.reconnected`).
- **Backend restart**: unchanged from before (runs are marked failed; there is
  no resume yet — see limitations).
- **Reconciliation** (every 10 min, first pass 30 s after boot): the worker
  asks `/worker/sandboxes/live` and removes ORVYN sandboxes that are not live
  and older than 2 min, ephemeral sandboxes of finished runs, and retained
  sandboxes past their TTL. With no answer from the control plane nothing is
  removed. The backend closes registry rows nobody reported on for 6 h.

## Deployment on the worker host

Service `openshell-gateway` (compose overlay `infrastructure/ovh/compose.openshell.yml`):

| Item | Value |
|---|---|
| Image | `ghcr.io/nvidia/openshell/gateway:0.1.2`, `user: "0"` (Docker socket) |
| Ports | `8080` gRPC+mTLS, published **only** on the Docker bridge IP (`OPENSHELL_BRIDGE_IP`, default `172.17.0.1`); `8081` health on the container loopback only. No Caddy route. |
| Private networking | worker → `https://openshell-gateway:8080` on the compose network; sandbox supervisors → `host.openshell.internal:8080` via host-gateway. Customer browsers have no path to it. |
| Volumes | `/var/run/docker.sock`; `/var/lib/openshell` (gateway SQLite); `/etc/orvyn/openshell/tls` (read-only PKI); `infrastructure/openshell/gateway.toml` (read-only) |
| Env | `OPENSHELL_GATEWAY_CONFIG`, `OPENSHELL_DB_URL`, `OPENSHELL_TLS_{CERT,KEY,CLIENT_CA}`, `OPENSHELL_ENABLE_MTLS_AUTH=true`, `OPENSHELL_DOCKER_TLS_*` |
| Worker env | `OPENSHELL_ENABLED`, `OPENSHELL_GATEWAY_URL`, `OPENSHELL_TLS_{CA,CERT,KEY}` (client cert, read-only mount), `OPENSHELL_SANDBOX_IMAGE`, `OPENSHELL_SANDBOX_UID=1000` |
| Backend env | `ORVYN_EXECUTION_PROVIDER`, `OPENSHELL_ENABLED`, `OPENSHELL_CANARY_ORGS`, `OPENSHELL_CANARY_PERCENT`, `OPENSHELL_ACCEPTANCE_PASSED`, `ORVYN_SANDBOX_RETAIN` |
| Restart | `unless-stopped` |
| Logging | json-file, 20 MB × 5; sandbox OCSF policy logs via `openshell logs <sandbox> --workspace <ws>` |
| Health / monitoring | distroless image, no in-container probe. The worker calls the gateway health RPC every 60 s and reports it with its heartbeat; admin System Health shows "Sandbox runtime: OpenShell gateway" (healthy workers, version, latency, active, failed/24 h, provision time, denials, reconnects, fallbacks). |
| Kernel | Linux ≥ 6.2 (Landlock ABI v3). `setup.sh` refuses older kernels. |

The deploy script adds the overlay and starts the gateway only when the
server's `.env` contains `OPENSHELL_ENABLED=true`.

## Staged rollout

1. **Local/dev** (done): unit tests, real-gateway acceptance (19/19), worker
   end-to-end on both providers (12/12 each).
2. **Server, dark**: run `infrastructure/openshell/setup.sh`; set
   `OPENSHELL_ENABLED=true`, `ORVYN_EXECUTION_PROVIDER=auto`; redeploy. No
   organization is in the canary, so nothing changes for customers. Import the
   `orvyn-github` profile. Run `scripts/acceptance/openshell-sandbox.mjs`
   inside the worker container (`ORVYN_WORKER_DIST=/app/dist/sandbox`,
   `ORVYN_TEST_WORKSPACE_ROOT=/opt/orvyn/workspaces/_acceptance`) and the
   worker e2e. Every check must pass.
3. **Internal canary**: turn on `openshell_runtime` for ORVYN's own
   organization (admin → customer → Sandboxes → "OpenShell canary on").
   Watch System Health for a week: failures, fallbacks, provision p95, denials.
4. **Customer canary**: a handful of opted-in organizations via the same flag
   (or `OPENSHELL_CANARY_ORGS`).
5. **Rollout**: set `OPENSHELL_ACCEPTANCE_PASSED=true` and raise
   `OPENSHELL_CANARY_PERCENT` (10 → 50 → 100). An explicit `off` flag always
   wins for an organization.

## Rollback (no database rollback)

- One organization: admin → customer → Sandboxes → **Force Docker**. Next run
  uses Docker.
- Everyone, instantly: set `ORVYN_EXECUTION_PROVIDER=docker` (or
  `OPENSHELL_ENABLED=false`) in `.env` and redeploy. Running missions finish on
  the sandbox they have; new ones use Docker.
- Remove entirely: also drop `OPENSHELL_ENABLED=true` so the overlay and
  gateway are not started. The registry tables stay; they are additive and
  unused by the Docker path.

## Tests

- `npm test -w @orvyn/worker` — templates, plan validation, classification,
  selection/fallback/reconnect/reconcile against fakes, real Docker provider.
- `apps/backend/src/execution/sandboxRegistry.test.ts` — registry immutability,
  canary gating, plan tiers, request → approval → credential flow, failure
  classes, worker-loss handling.
- `scripts/acceptance/openshell-sandbox.mjs` — real gateway: mTLS, cross-tenant
  filesystem/sandbox/terminal/mount, deny-by-default network, live policy,
  credential exfiltration, durability, worker restart, reconciliation,
  performance.
- `scripts/acceptance/worker-sandbox-e2e.mjs` — the real worker process, one
  mission end to end, on either provider.


## Limitations (updated 2026-09-30)

- Backend restart now re-queues orphaned runs (boot recovery scans RunStore
  journals for live-status runs and re-queues with recover=true).
- Worker fencing: tool result submissions are rejected if the submitting
  worker is not the one currently assigned (prevents zombie workers).
- Compose pins by version tag; digest pinning requires a manual pull +
  `docker inspect` after first deploy. setup.sh records digests at install.
- Browser inside the sandbox, portal terminal attach, MCP inside the sandbox,
  checkpoint fields, and non-GitHub credentials remain open.
