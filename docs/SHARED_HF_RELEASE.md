# Shared hosted routing production promotion

Base: `7f5e129c992f02c4133145141d23119dde25eebb` on `codex/production-signup-hf`. Only the files below are promoted; the divergent runtime branch is not merged.

Cloud and downloaded Desktop use the hosted backend with GitHub Actions-managed inference credentials. Fresh Desktop installs default to Cloud; existing saved settings remain intact. GitHub stores deployment secrets, not a public runtime credential service. No inference token enters the Windows build or live Desktop test.

Auto compares compatible verified equivalent HF, Nebius and Fireworks routes using current published input/output prices. Flash ties retain Nebius; cheaper verified HF advanced/coding routes can win. Missing prices retain existing routes. Research and premium limits remain unchanged. HF capability checks include a live tool/SSE probe, image probe where advertised, catalog context, and expiring current prices. Retired Fireworks Kimi Code serverless is excluded; configured on-demand routes are preserved.

Usage captures actual provider/model and exact rate version, retains reported zero/cache counts, marks estimates, and preserves prior ledger charges. Rates refresh independently of plans. Provider usage estimates and unknown-price legacy routes remain explicitly distinguishable. No global cheapest-provider claim is made.

Release sequence: workspace builds/tests and backend Docker build → isolated staging → packaged Windows Desktop against staging → gated production workflow → production HF smoke and packaged Desktop against production. A production release requires the explicit commit marker `[release-production]` (or manual dispatch where available). Each live smoke must report HF rather than fallback. Dedicated fixture accounts are removed after tests; immutable billing audit entries remain.

Rollback: tag the previous production image `orvyn-backend:rollback-7f5e129` before deploy; retain the script-created database backup and environment values. Restore the previous backend image with the existing Compose stack, preserving named volumes, then check the health SHA. Do not restore the database merely to roll back code.

| File | Why required |
| --- | --- |
| `.dockerignore` | Exclude credentials and generated artifacts from both Docker build contexts |
| `.github/workflows/ci.yml` | Build, isolated staging, hosted Desktop and guarded OVH production release gates |
| `apps/backend/src/agent/AgentService.ts` | Apply shared verified routing, cancellation and telemetry to existing request paths |
| `apps/backend/src/agent/StreamingAgentRuntime.ts` | Apply shared verified routing, cancellation and telemetry to existing request paths |
| `apps/backend/src/ai/Orchestrator.ts` | Apply shared verified routing, cancellation and telemetry to existing request paths |
| `apps/backend/src/billing/CreditLedger.ts` | Accurate provider telemetry, captured rate versions, cached tokens and settlement |
| `apps/backend/src/billing/creditLedger.test.ts` | Focused regression coverage for the changed behavior |
| `apps/backend/src/billing/plans.ts` | Distinguish ordinary and explicitly premium per-image billing lanes |
| `apps/backend/src/composer/ComposerService.ts` | Apply shared verified routing, cancellation and telemetry to existing request paths |
| `apps/backend/src/edit/CompleteService.ts` | Apply shared verified routing, cancellation and telemetry to existing request paths |
| `apps/backend/src/edit/InlineEditService.ts` | Apply shared verified routing, cancellation and telemetry to existing request paths |
| `apps/backend/src/index.ts` | Apply shared verified routing, cancellation and telemetry to existing request paths |
| `apps/backend/src/models/customerCatalog.test.ts` | Focused regression coverage for the changed behavior |
| `apps/backend/src/models/customerCatalog.ts` | Compatible routing, equivalent model fallbacks and safe public telemetry |
| `apps/backend/src/models/huggingFaceRouting.test.ts` | Focused regression coverage for the changed behavior |
| `apps/backend/src/models/modelEquivalents.ts` | Compatible routing, equivalent model fallbacks and safe public telemetry |
| `apps/backend/src/models/routingPolicy.test.ts` | Focused regression coverage for the changed behavior |
| `apps/backend/src/models/routingPolicy.ts` | Compatible routing, equivalent model fallbacks and safe public telemetry |
| `apps/backend/src/models/selectModel.ts` | Compatible routing, equivalent model fallbacks and safe public telemetry |
| `apps/backend/src/routes/v1.ts` | Apply shared verified routing, cancellation and telemetry to existing request paths |
| `apps/backend/src/services/ModelService.ts` | Register HF coding route and verified refreshable capabilities/rates |
| `apps/backend/src/services/UsageService.ts` | Accurate provider telemetry, captured rate versions, cached tokens and settlement |
| `apps/backend/src/services/usageMetering.test.ts` | Focused regression coverage for the changed behavior |
| `apps/backend/src/sessions/sessionMessages.ts` | Display and persist the provider/model that actually answered |
| `apps/backend/src/tenancy/TenantManager.ts` | Accurate provider telemetry, captured rate versions, cached tokens and settlement |
| `apps/desktop/src/main/main.ts` | Hosted default for fresh installs; preserve saved connections and secure sessions |
| `apps/desktop/src/renderer/chatSession.ts` | Display and persist the provider/model that actually answered |
| `apps/desktop/src/renderer/components/WorkStream.tsx` | Display and persist the provider/model that actually answered |
| `apps/desktop/src/renderer/connection.ts` | Hosted default for fresh installs; preserve saved connections and secure sessions |
| `apps/desktop/src/renderer/connectionMode.test.ts` | Focused regression coverage for the changed behavior |
| `apps/desktop/src/renderer/orvynCommand.ts` | Display and persist the provider/model that actually answered |
| `apps/web/src/components/ChatThread.tsx` | Display and persist the provider/model that actually answered |
| `apps/web/src/lib/chatSocket.ts` | Display and persist the provider/model that actually answered |
| `package.json` | Include the credential-isolation regression in the existing test suite |
| `packages/ai-core/src/adapters/openaiCompatibleAdapter.ts` | Shared cached-token, rate and actual-route metadata contracts |
| `packages/ai-core/src/index.ts` | Shared cached-token, rate and actual-route metadata contracts |
| `packages/ai-core/src/router.ts` | Shared compatible, price-qualified Auto policy and explicit overrides |
| `packages/ai-core/src/types.ts` | Shared cached-token, rate and actual-route metadata contracts |
| `scripts/deploy-ovh-staging.sh` | Build, isolated staging, hosted Desktop and guarded OVH production release gates |
| `scripts/deploy-ovh.sh` | Pass provider model/base URL settings through the existing secret/variable mechanism while preserving nonempty unrelated settings |
| `apps/backend/src/models/huggingFaceVerification.ts` | Verify live HF catalog, tools, streaming, vision, context and prices |
| `apps/backend/src/models/providerRates.test.ts` | Focused regression coverage for the changed behavior |
| `apps/backend/src/models/providerRates.ts` | Refresh exact published provider/model billing and comparison rates |
| `apps/desktop/src/main/providerEnvironment.test.ts` | Focused regression coverage for the changed behavior |
| `apps/desktop/src/main/providerEnvironment.ts` | Keep inherited inference credentials in the main/backend processes only |
| `packages/ai-core/src/autoRouting.ts` | Shared compatible, price-qualified Auto policy and explicit overrides |
| `scripts/acceptance/hf-desktop-runtime.mjs` | Packaged Desktop checks against hosted inference using an isolated account |
| `scripts/acceptance/hf-routing-preflight.cjs` | Bounded real HF coding/tool/provider smoke evidence |
| `scripts/acceptance/hosted-release-fixture.cjs` | Packaged Desktop checks against hosted inference using an isolated account |
| `docs/SHARED_HF_RELEASE.md` | Promotion scope, verification gates and rollback record |

CI attempt 37145988788 passed Windows packaging, Docker build and signup browser checks; staging stopped before rebuilding because .dockerignore was missing. Added the tracked Docker exclusions and completed the guarded smoke account onboarding fixture before retry.

## Added release scope requested during verification

Server diagnosis starts with compatible GLM-5.3-Flash and escalates through the existing server ladder. Routine writing uses the exact direct Fireworks `accounts/fireworks/models/deepseek-v4-flash-0731` only after public context/prices and actual streaming tools verify. The proposed HF/DeepInfra DeepSeek route is not registered. Explicit selections remain authoritative. On October 3 the exact Fireworks model's official DeepSeek page says **Serverless Not supported**; it must not be enabled merely because its state says Ready. Staging includes a bounded direct account-availability probe and rejects fallback as a pass.

Kontext Pro remains the default; Max requires explicit premium quality or model selection. Image calls, including the direct Kontext HTTP path, pass through a shared metering boundary. Current per-image quotes are captured and audited separately from token cards. Cloud refuses unpriced images. Persisted pre-call leases account for image batches, simultaneous requests, credit balance and rolling windows; failures release leases and charge zero. Historical ledger entries and settings remain intact.

Desktop-owned Auto coding uses Docker with the existing project tools bundled inside its container, rather than the host executor. Cloud coding uses its worker; missing workers/sandboxes stop the run. Host remains explicit. Project secrets are excluded from container copies and SDK calls never receive provider credentials. Existing MCP connection/authentication indicators and Local Only labels remain authoritative; Cloud's MCP gateway already refuses local stdio calls. Existing approval scopes and audit storage remain shared. Docker acceptance gates exercise file editing, real tests, credential exclusion, cancellation and merging; the Cloud worker RPC acceptance also gates releases. Actual SSH/MCP setup still requires configured resources; synthetic fixtures do not prove a customer's connection works.

| Additional file | Why required |
| --- | --- |
| `apps/backend/package.json` | Build the shared project-tool sandbox bundle; declare its build dependency |
| `package-lock.json` | Pin the bundle compiler dependency |
| `apps/backend/scripts/build-sandbox-tools.cjs` | Package existing tools for execution inside Docker |
| `apps/backend/src/localWorker/sandboxToolsEntry.ts` | Execute the existing file, terminal and diagnostic tools inside the container |
| `apps/backend/src/localWorker/LocalSandboxExecutor.ts` | Connect the Desktop worker to the existing Docker sandbox lifecycle |
| `apps/backend/src/localWorker/entry.ts` | Dispatch sandbox jobs truthfully and stop their containers on cancellation |
| `apps/backend/src/routes/localWorker.ts` | Tenant-scoped cancellation status without consuming tool requests |
| `apps/backend/src/sandbox/DockerSandbox.ts` | Copy the SDK, exclude secret files and guard merge-back paths |
| `apps/backend/src/execution/ExecutionTarget.ts` | Distinguish Desktop projects from Cloud projects and default coding to the correct isolated target |
| `apps/backend/src/execution/ExecutionRouter.ts` | Stop unavailable isolation/remote targets rather than running on the host |
| `apps/backend/src/execution/ExecutionTarget.test.ts` | Target/default/explicit-selection regressions |
| `apps/backend/src/execution/execution.test.ts` | Unavailable remote target regressions |
| `apps/backend/src/execution/acceptanceMatrix.test.ts` | Product target, gateway denial and actual Desktop Docker acceptance |
| `apps/backend/src/agent/runPreflightResult.test.ts` | Keep preflight consistent with the new Desktop default |
| `apps/backend/src/billing/imageBilling.test.ts` | Per-image charging, batch counts, concurrent allowances, failures and replay protection |
| `apps/backend/src/images/ImageService.ts` | Meter direct Kontext calls and keep premium fallback explicit |
| `apps/backend/src/models/fireworksVerification.ts` | Verify the exact writing route, current prices/context and real streaming tools |
| `apps/backend/src/models/fireworksWriting.test.ts` | Exact route, missing availability, explicit models and premium image regressions |
| `apps/backend/src/models/providerFailover.test.ts` | Server Flash default with Nebius-only configuration |
| `apps/backend/src/models/routingPolicy.test.ts` | Server Flash tier ordering |
| `apps/backend/src/models/selectModel.test.ts` | Server Flash selection with other models available |
| `apps/worker/src/sandbox/docker.ts` | Run the isolated Cloud container as its workspace owner so worker edits remain writable without adding capabilities |

Previously listed shared routing, metering, billing, policy, CI and deployment files also receive these narrowly related changes. The candidate remains **staging-only** until all mandatory gates pass; a commit without `[release-production]` cannot trigger the production promotion.

CI 37148661824 passed the real Desktop Docker matrix (3/3) and Windows packaging. The newly required Cloud worker acceptance exposed host/container ownership mismatch with capabilities dropped: 10/12 passed, worker edits could not be appended by the container. The container now uses the workspace owner's UID/GID; isolation stays intact. The exact Fireworks page also explicitly confirms serverless retirement beginning September 25, 2026, recommending DeepSeek V4.1 Flash. A replacement remains subject to the user's selected model and staging verification.

CI 37148957057 passed the full suite, Desktop Docker 3/3, Cloud worker 12/12, Windows packaging, production Docker build and signup browser regression. It deployed only isolated staging at `31897eb79d39a2b072f12ad65c414fc81b7ccadd`; HF Auto coding passed with actual provider/model and three tools. Fireworks failed because its credential/model was absent. Production remained `7f5e129`. The Fireworks verification is now a separate mandatory production gate so packaged Desktop HF verification can proceed independently. Merge-back also rejects files changed by Cursor/users while a sandbox runs; an isolated OVH-host test passed the real Docker matrix including that conflict guard (3/3).

CI 37150314810 passed build, Docker/signup checks, both sandbox matrices, Windows packaging and isolated staging at `c835a94`. The actual packaged Windows Desktop test passed Auto HF Kimi Code, explicit HF GLM-5.3, inline edit, streaming, cancellation and recorded usage; no inference credential entered the app. Its dedicated account was cleaned up. The job then failed deleting its temporary SSH key because the restricted owner ACL granted read only. The ACL now grants full control to the same sole owner so deletion succeeds without exposing it to other users. Fireworks still failed its separate mandatory gate; production stayed `7f5e129`.
