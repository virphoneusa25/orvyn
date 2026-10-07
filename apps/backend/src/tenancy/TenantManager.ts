// apps/backend/src/tenancy/TenantManager.ts
//
// Multi-tenancy foundation. Before this, every service was a module-level
// singleton, which meant all customers shared one model registry, one tool
// registry, one vector index and one pool of agent sessions — i.e. Customer B's
// codebase search could return Customer A's source. That is a data-leak bug,
// not merely a scaling limit.
//
// Every tenant now gets its own instances. Nothing is shared except stateless
// adapter classes.

import { WorkSessionStore, type WorkSessionPersistence } from "../sessions/WorkSessionStore";
import { createHash, randomUUID, timingSafeEqual } from "crypto";
import { join as pathJoin } from "path";
import { defaultDataDir } from "../persistence/LocalStore";
import { releaseSandboxControlForRun } from "../desktop/sandboxDesktop";
import { creditLedger } from "../billing/AsyncFinancialStores";
import { recordProviderQuote } from "../billing/providerSettlement";
import { TenantBilling } from "../billing/TenantBilling";
import { customerCatalogEnabled, isUserModelId } from "../models/customerCatalog";
import { openModelConfig } from "../models/userModels";
import { laneForUsage } from "../billing/plans";
import { requiredCapability, TaskType } from "@orvyn/ai-core";
import { embedModelChoice, ModelService } from "../services/ModelService";
import { IndexService } from "../indexing/IndexService";
import { HashingEmbedder, ModelEmbedder } from "../indexing/embeddings";
import { NamespacedVectorStore } from "../indexing/NamespacedVectorStore";
import { QdrantVectorStore } from "../indexing/QdrantVectorStore";
import { ResilientVectorStore } from "../indexing/ResilientVectorStore";
import { ToolRegistry } from "../ai/ToolTypes";
import { ToolGateway } from "../gateway/ToolGateway";
import { PermissionEngine } from "../gateway/PermissionEngine";
import { ModelGateway } from "../gateway/ModelGateway";
import type { AgentSession } from "../agent/AgentService";
import { RunStore } from "../agent/events";
import { EventBus } from "../agent/EventBus";
import { TaskEngine } from "../agent/TaskEngine";
import { StreamingAgentRuntime } from "../agent/StreamingAgentRuntime";
import { MultiAgentRuntime } from "../agent/MultiAgentRuntime";
import { CheckpointEngine } from "../checkpoint/CheckpointEngine";
import { McpHub } from "../mcp/McpHub";
import { McpManager } from "../mcp/McpManager";
import { marketplaceFor } from "../mcp/marketplace/service";
import { hardeningFor } from "../mcp/hardening/hardening";
import { sanitizeToolName } from "../mcp/McpToolAdapter";
import { ContextEngine } from "../context/ContextEngine";
import { LocalStore } from "../persistence/LocalStore";
import { ArtifactService } from "../artifacts/ArtifactService";
import { ExperienceStore } from "../learning/ExperienceStore";
import { persistSkillCandidates } from "../learning/skillCandidates";
import { seedValidatedSkills } from "../learning/validatedSkills";
import { persistDataset } from "../learning/datasetBuilder";
import { DEFAULT_PRIVACY } from "../orgs/organization";
import type { Principal } from "../identity/principal";
import { PROFILES, PermissionProfile } from "../gateway/PermissionProfiles";

export interface Tenant {
  id: string;
  name: string;
  createdAt: string;
  modelService: ModelService;
  indexService: IndexService;
  toolRegistry: ToolRegistry;
  /** Sole tool registration/execution path (registry + capability engine). */
  toolGateway: ToolGateway;
  permissionEngine: PermissionEngine;
  modelGateway: ModelGateway;
  agentSessions: Map<string, AgentSession>;
  runStore: RunStore;
  eventBus: EventBus;
  taskEngine: TaskEngine;
  checkpointEngine: CheckpointEngine;
  mcpHub: McpHub;
  /** Full MCP host: persistent servers, gateway-registered tools, search. */
  mcpManager: McpManager;
  contextEngine: ContextEngine;
  agentRuntime: StreamingAgentRuntime;
  multiAgentRuntime: MultiAgentRuntime;
  /** Project root most recently used, so tools can be (re)registered per tenant. */
  currentProjectRoot: string | null;
  usage: { requests: number; agentRuns: number; indexBuilds: number };
  /** Durable local storage (missions, usage, settings, models). */
  localStore: LocalStore;
  /** Tenant-scoped virtual workspace + generated-file store. */
  artifactService: ArtifactService;
  experienceStore: ExperienceStore;
  /** Durable WorkSessions: conversation → workspace → runs. Authoritative. */
  sessions: WorkSessionPersistence;
}

function embedderFor(ms: ModelService) {
  try {
    const provider = ms.router.resolve("embedding");
    const chosen = embedModelChoice();
    const dims = chosen?.id === provider.config.id ? chosen.dims : Number(process.env.OPENAI_EMBED_DIMS) || 1536;
    return {
      embedder: new ModelEmbedder(provider, dims),
      label: provider.config.id,
      // An explicitly chosen embedder gets its own vector space (never mixed with another model's vectors).
      space: chosen?.id === provider.config.id ? `-${provider.config.id.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}_${dims}` : "",
    };
  } catch {
    return { embedder: new HashingEmbedder(), label: "hash", space: "" };
  }
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class TenantManager {
  private tenants = new Map<string, Tenant>();
  /** sha256(apiKey) -> tenantId. Raw keys are never stored. */
  private keyIndex = new Map<string, string>();

  private creating = new Map<string, Promise<Tenant>>();

  constructor(private openStore: (id: string) => LocalStore = (id) => new LocalStore(id)) {}

  create(name: string, apiKey: string, id: string = randomUUID()): Promise<Tenant> {
    const existing = this.tenants.get(id);
    if (existing) return Promise.resolve(existing);
    const pending = this.creating.get(id);
    if (pending) return pending;
    const creation = Promise.resolve().then(() => this.buildTenant(name, apiKey, id));
    this.creating.set(id, creation);
    void creation.then(() => this.creating.delete(id), () => this.creating.delete(id));
    return creation;
  }

  private async buildTenant(name: string, apiKey: string, id: string): Promise<Tenant> {
    const localStore = this.openStore(id);
    let sessionStore: WorkSessionPersistence | undefined;
    try {
    const modelService = new ModelService();
    // Restore the customer's own models (keys are sealed at rest). On ORVYN
    // Cloud only "my:" models are the customer's: an old saved edit of one of
    // ORVYN's models is ignored, so ORVYN's model always stands.
    for (const saved of await localStore.loadModels()) {
      try {
        const cfg = openModelConfig(saved, id);
        if (customerCatalogEnabled() && !isUserModelId(cfg.id)) {
          console.warn(JSON.stringify({ event: "models.platform_edit_ignored", tenantId: id, modelId: cfg.id }));
          continue;
        }
        modelService.removeModel(cfg.id);
        modelService.addModel(cfg, "user");
      } catch (err: any) {
        console.warn(`Skipping persisted model "${saved.id}": ${err.message}`);
      }
    }
    const preferred = await localStore.getSetting("preferredModel");
    if (preferred && modelService.isUserModel(preferred)) modelService.preferredModel = preferred;
    // Every provider is metered; from here they're also durably recorded.
    await modelService.usage.attachStore(localStore);
    const billing = new TenantBilling(creditLedger, id, localStore);
    void modelService.huggingFaceReady.then(async () => {
      for (const p of modelService.registry.list()) {
        if (modelService.isUserModel(p.config.id)) continue;
        const rate = p.config.rate, imageRate = p.config.imageRate;
        if (rate && rate.expiresAt > Date.now()) await recordProviderQuote(creditLedger, { provider: p.config.providerName ?? p.config.provider, modelId: p.config.id, rate });
        if (imageRate && imageRate.expiresAt > Date.now()) await recordProviderQuote(creditLedger, { provider: p.config.providerName ?? p.config.provider, modelId: p.config.id, imageRate });
      }
    }).catch(() => console.warn("Provider billing price initialization failed; paid calls remain guarded."));
    // Before every model call: the wallet (balance, rolling windows, the run's
    // budget) must be able to pay for it. Enforced on ORVYN Cloud; a local
    // engine running on the user's own keys only records.
    modelService.usage.onPreflight(async (ctx, model) => {
      if (!creditsEnforced()) return;
      await billing.awaitRun(ctx.missionId);
      await billing.recover(creditsEnforced());
      // The customer's own model runs on their provider account, not ORVYN credits.
        if (model && modelService.isUserModel(model.id)) return;
        if (model?.method === "image") {
          const rate = model.imageRate;
          if (Number.isFinite(model.imageSettlementBudgetUsd) && model.imageSettlementBudgetUsd! > 0 && model.rate && model.rate.expiresAt > Date.now()) return creditLedger.reserveImage(id, model.imageCount ?? 1, "image", model.providerCostUsd!);
          if (!rate || rate.expiresAt <= Date.now() || !Number.isFinite(rate.usdPerImage) || rate.usdPerImage <= 0) {
            throw new Error("Image generation is unavailable until a current per-image price is configured.");
          }
          return creditLedger.reserveImage(id, model.imageCount ?? 1, rate.premium ? "image_pro" : "image", model.providerCostUsd!);
        }
      if (!model?.rate || model.rate.expiresAt <= Date.now() || ![model.rate.input, model.rate.output, model.rate.cachedInput ?? model.rate.input].every((n) => Number.isFinite(n) && n >= 0)) {
        throw new Error("This model is unavailable until a current exact billing price is configured.");
      }
      await recordProviderQuote(creditLedger, { provider: model.providerName ?? model.provider ?? "", modelId: model.id, rate: model.rate });
      await creditLedger.assertCanSpend(id, ctx.missionId, Date.now(), { lane: laneForUsage(ctx) });
    });
    // After it: settle exactly once per call (the usage event id is the key).
      modelService.usage.onRecord(async (event) => {
        const own = modelService.isUserModel(event.modelId);
        await billing.record(event, own, creditsEnforced());
    });
    // Restore the user's routing choices, the same way the autonomy profile is
    // restored. Without this, every restart silently reverted routing to the
    // env-seeded defaults — which may point at a provider with dead credits.
    const savedRouting = await localStore.getSetting("routing");
    if (savedRouting) {
      try {
        for (const [task, modelId] of Object.entries(JSON.parse(savedRouting))) {
          const provider = modelService.registry.get(String(modelId));
          if (!provider) continue; // model was removed; env default stands
          if (!provider.config.capabilities[requiredCapability(task as TaskType)] && provider.config.routingVerification?.status !== "pending") continue;
          modelService.router.setOverride(task as TaskType, String(modelId));
        }
      } catch {
        // Corrupt setting — ignore and keep env defaults.
      }
    }
    const { embedder, label, space } = embedderFor(modelService);
    const toolRegistry = new ToolRegistry();
    const permissionEngine = new PermissionEngine();
    const tenant: Tenant = {
      id,
      name,
      createdAt: new Date().toISOString(),
      modelService,
      indexService: new IndexService(embedder, new ResilientVectorStore(
        // Qdrant-first (remote, scalable), local fallback when unreachable
        process.env.ORVYN_QDRANT_URL
          ? new QdrantVectorStore({
              url: process.env.ORVYN_QDRANT_URL,
              collection: `orvyn_code${space}`,
              dimension: embedder.dimensions,
            }, id, "default")
          : new NamespacedVectorStore(pathJoin(defaultDataDir(), `vectors-${id}${space}.json`)),
        new NamespacedVectorStore(pathJoin(defaultDataDir(), `vectors-${id}${space}.json`)),
      ), label, id),
      toolRegistry,
      permissionEngine,
      toolGateway: new ToolGateway(toolRegistry, permissionEngine),
      modelGateway: new ModelGateway(modelService),
      agentSessions: new Map(),
      runStore: undefined as unknown as RunStore,
      eventBus: undefined as unknown as EventBus,
      taskEngine: undefined as unknown as TaskEngine,
      checkpointEngine: new CheckpointEngine(),
      mcpHub: new McpHub(),
      mcpManager: undefined as unknown as McpManager,
      contextEngine: undefined as unknown as ContextEngine,
      agentRuntime: undefined as unknown as StreamingAgentRuntime,
      multiAgentRuntime: undefined as unknown as MultiAgentRuntime,
      currentProjectRoot: null,
      usage: { requests: 0, agentRuns: 0, indexBuilds: 0 },
      localStore,
      artifactService: new ArtifactService(id, localStore),
      experienceStore: new ExperienceStore(id, localStore),
      sessions: (sessionStore = new WorkSessionStore(id)),
    };
    (await seedValidatedSkills(localStore));
    // MCP host gets the now-constructed tenant's gateway.
    tenant.mcpManager = new McpManager({
      gateway: tenant.toolGateway,
      engine: tenant.permissionEngine as unknown as { declareCapabilities(name: string, caps: string[]): void; forgetCapabilities(name: string): void },
      tenantId: id,
      store: localStore as unknown as { getSetting(k: string): unknown; setSetting(k: string, v: string): void; deleteSetting?(k: string): void },
    });
    await tenant.mcpManager.ready;
    const harden = hardeningFor(tenant.mcpManager, localStore, id);
    await harden.ready;
    tenant.mcpManager.setStartGuard((serverId) => {
      const cfg = tenant.mcpManager.listServers().find((s) => s.id === serverId);
      return harden.denyServer({
        id: cfg?.id,
        marketplaceId: cfg?.marketplaceId,
        packageIdentifier: cfg?.packageIdentifier,
        sourceProviders: cfg?.sourceProviders,
      });
    });
    tenant.mcpManager.setToolGuard((_serverId, tool) => (harden.toolHardDenied(tool) ? `Admin hard deny: ${tool}` : null));
    tenant.mcpManager.setRestartHook((serverId) => {
      const decision = harden.obs.canRestart(serverId);
      if (!decision.ok) return;
      harden.obs.noteRestart(serverId);
      setTimeout(() => {
        void tenant.mcpManager.connect(serverId).then((st) => {
          if (st.state === "CONNECTED") harden.obs.resetRestarts(serverId);
        }).catch(() => {});
      }, decision.waitMs);
    });
    // Restore the autonomy profile the user last selected.
    const savedProfile = (await localStore.getSetting("profile")) as PermissionProfile | null;
    if (savedProfile && PROFILES[savedProfile]) tenant.toolGateway.profile = savedProfile;
    // Streaming runtime is per-tenant too, so runs and their event logs are
    // never visible across customers. The store gets a per-tenant directory:
    // events append to disk as they stream and replay after a restart.
    tenant.runStore = new RunStore(pathJoin(defaultDataDir(), `runs-${id}`));
    // A finished run must not keep the desktop input-blocked: when the run
    // that held sandbox control ends, control returns to the user (the pane
    // reconciles within one 2s session poll; the event helps live viewers).
    // Credits: reserve → execute → settle → release. A run holds up to its
    // plan's per-run budget (never more than the wallet has); every model call
    // settles against the hold; what is left returns when the run ends.
    tenant.runStore.onCreated((runId) => {
      if (!creditsEnforced()) return;
      void billing.reserveRun(runId).catch((err) => {
        console.warn(JSON.stringify({ event: "credits.reserve_failed", tenantId: id, runId, code: (err as { code?: string }).code ?? "ERROR" }));
      });
    });
    tenant.runStore.onTerminalStatus((runId) => {
      void billing.releaseRun(runId).catch(() => {
        console.warn(JSON.stringify({ event: "credits.release_failed", tenantId: id, runId }));
      });
    });
    tenant.runStore.onTerminalStatus((runId) => {
      const released = releaseSandboxControlForRun(runId);
      if (released) {
        try {
          tenant.runStore.emit(runId, "desktop.control.changed", {
            sessionId: released.id,
            to: "user",
            controlOwner: "user",
            status: "user_control",
            reason: "run-finished",
          });
        } catch { /* the run's subscribers may already be gone */ }
      }
    });
    tenant.eventBus = new EventBus(tenant.runStore);
    tenant.taskEngine = new TaskEngine(tenant.eventBus, localStore);
    await tenant.taskEngine.ready;
    tenant.contextEngine = new ContextEngine(tenant.toolGateway);
    tenant.agentRuntime = new StreamingAgentRuntime(
      tenant.modelService,
      tenant.toolGateway,
      tenant.runStore,
      tenant.checkpointEngine,
      tenant.localStore,
      tenant.indexService,
      () => tenant.mcpManager.capabilitySummary(),
      (name) => marketplaceFor(tenant.mcpManager, localStore, id).index.exposeToModel(name)
    );
    const market = marketplaceFor(tenant.mcpManager, localStore, id);
    market.index.rankContext = {
      get projectRoot() {
        return tenant.currentProjectRoot;
      },
      inScope: (serverName) => {
        const cfg = tenant.mcpManager.listServers().find((s) => s.name === serverName);
        if (!cfg) return true;
        return harden.inScope(cfg, tenant.currentProjectRoot);
      },
      healthOf: (serverName) => {
        const cfg = tenant.mcpManager.listServers().find((s) => s.name === serverName);
        if (!cfg) return {};
        const st = tenant.mcpManager.status(cfg.id);
        return harden.obs.snapshot(cfg.id, {
          state: st?.state ?? "DISCONNECTED",
          toolCount: st?.toolCount ?? 0,
          lastConnectedAt: st?.lastConnectedAt,
          enabled: cfg.enabled,
          blocked: cfg.blocked,
        });
      },
    };
    tenant.agentRuntime.setHardeningHooks({
      artifacts: tenant.artifactService,
      cloudMcpInvoke: async ({ runId, tool, args, projectRoot }) => {
        const serverKey = tool.split(".")[1] ?? "";
        const cfg = tenant.mcpManager.listServers().find((s) => sanitizeToolName(s.name) === serverKey);
        if (!cfg) return { ok: false, error: "Unknown MCP server for this tenant" };
        const out = await harden.gateway.invoke({
          tenantId: id,
          expectedTenantId: id,
          serverId: cfg.id,
          tool,
          args,
          runId,
          projectRoot,
          cloudRun: true,
        });
        await harden.appendAudit("tool invocation", { serverId: cfg.id, tool, ok: out.ok, runId, executionLocation: out.executionLocation });
        return { ok: out.ok, output: out.output, error: out.error };
      },
      onRunSettled:  async (runId) => {
        for (const s of tenant.mcpManager.listServers()) {
          if (s.scope === "run") (await tenant.mcpManager.setEnabled(s.id, false));
        }
        if (DEFAULT_PRIVACY.trainingOptOut) return;
        try {
          const run = tenant.runStore.get(runId);
          if (!run) return;
          (await tenant.experienceStore.captureFromRun(run));
          const experiences = (await tenant.experienceStore.list("experience", 80));
          (await persistSkillCandidates(tenant.localStore, experiences));
          (await persistDataset(tenant.localStore, experiences));
        } catch {
          /* learning must never fail a run */
        }
      },
    });
    tenant.multiAgentRuntime = new MultiAgentRuntime(
      tenant.modelService,
      tenant.toolGateway,
      tenant.runStore,
      tenant.taskEngine,
      tenant.eventBus
    );

    this.tenants.set(id, tenant);
    if (apiKey) this.keyIndex.set(hashKey(apiKey), id);
    return tenant;
    } catch (error) {
      try { await sessionStore?.close(); } catch {}
      try { localStore.close(); } catch {}
      throw error;
    }
  }

  resolveByApiKey(apiKey: string): Tenant | undefined {
    const hashed = hashKey(apiKey);
    // Constant-time compare against known hashes to avoid leaking key material
    // through response-timing differences.
    for (const [candidate, tenantId] of this.keyIndex) {
      if (safeEqual(candidate, hashed)) return this.tenants.get(tenantId);
    }
    return undefined;
  }

  get(id: string): Tenant | undefined {
    return this.tenants.get(id);
  }

  list(): Tenant[] {
    return Array.from(this.tenants.values());
  }

  hasRegisteredKeys(): boolean {
    return this.keyIndex.size > 0;
  }

  /** Local unauthenticated mode: one tenant so routes still have req.tenant. */
   async ensureLocalDefault(): Promise<Tenant> {
    return this.get("default") ?? (await this.create("default", "", "default"));
  }

  /**
   * Per-user tenant: each signed-in account gets its own isolated services
   * and its own SQLite store (user_<id>.db). Created lazily on first request.
   */
   async ensureUserTenant(userId: string, label: string): Promise<Tenant> {
    const id = `user_${userId}`;
    return this.get(id) ?? (await this.create(label, "", id));
  }

  /** Session-resolved org tenant. Personal orgs keep user_<id> so existing stores stay valid. */
   async ensureOrgTenant(principal: Principal): Promise<Tenant> {
    const id = principal.tenantId || `user_${principal.userId}`;
    return this.get(id) ?? (await this.create(principal.organizationName || principal.email, "", id));
  }

  revokeKey(apiKey: string): void {
    this.keyIndex.delete(hashKey(apiKey));
  }

  addKey(tenantId: string, apiKey: string): void {
    if (!this.tenants.has(tenantId)) throw new Error(`Unknown tenant "${tenantId}"`);
    this.keyIndex.set(hashKey(apiKey), tenantId);
  }
}

export const tenantManager = new TenantManager();

// Single-tenant convenience: when ORVYN_API_KEY is set (the existing
// deployment shape), seed one "default" tenant with that key so nothing
// breaks for current installs. Multi-tenant setups create tenants explicitly.
export async  function bootstrapDefaultTenant(): Promise<Tenant | null> {
  const key = process.env.ORVYN_API_KEY?.trim();
  if (key) return (await tenantManager.create("default", key, "default"));
  return (await tenantManager.ensureLocalDefault());
}

/** Credits gate model calls on ORVYN Cloud (or when forced on for testing). */
export function creditsEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ORVYN_ENFORCE_CREDITS === "false") return false;
  return env.ORVYN_ENFORCE_CREDITS === "true" || env.ORVYN_CLOUD_MODE === "true";
}
