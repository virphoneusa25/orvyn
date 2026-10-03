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
