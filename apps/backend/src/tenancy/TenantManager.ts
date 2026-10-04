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

import { createHash, randomUUID, timingSafeEqual } from "crypto";
import { join as pathJoin } from "path";
import { defaultDataDir } from "../persistence/LocalStore";
import { requiredCapability, TaskType } from "@orvyn/ai-core";
import { ModelService } from "../services/ModelService";
import { IndexService } from "../indexing/IndexService";
import { HashingEmbedder, ModelEmbedder } from "../indexing/embeddings";
import { InMemoryVectorStore } from "../indexing/vectorStore";
import { ToolRegistry } from "../ai/ToolTypes";
import { ToolGateway } from "../gateway/ToolGateway";
import { PermissionEngine } from "../gateway/PermissionEngine";
import { ModelGateway } from "../gateway/ModelGateway";
import type { AgentSession } from "../agent/AgentService";
import { RunStore, isTerminal } from "../agent/events";
import { EventBus } from "../agent/EventBus";
import { TaskEngine } from "../agent/TaskEngine";
import { StreamingAgentRuntime } from "../agent/StreamingAgentRuntime";
import { MultiAgentRuntime } from "../agent/MultiAgentRuntime";
import { CheckpointEngine } from "../checkpoint/CheckpointEngine";
import { McpHub } from "../mcp/McpHub";
import { ContextEngine } from "../context/ContextEngine";
import { createTenantStore, type TenantStore } from "../persistence/TenantStore";
import { PROFILES, PermissionProfile } from "../gateway/PermissionProfiles";
import {
  getDistributedMissionCoordinator,
  isDistributedRun,
} from "../queue/DistributedMissionCoordinator";
import { distributedRuntimeReady } from "../queue/redisConnection";

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
  contextEngine: ContextEngine;
  agentRuntime: StreamingAgentRuntime;
  multiAgentRuntime: MultiAgentRuntime;
  /** Project root most recently used, so tools can be (re)registered per tenant. */
  currentProjectRoot: string | null;
  usage: { requests: number; agentRuns: number; indexBuilds: number };
  /** Durable tenant storage (SQLite locally, PostgreSQL in cloud-primary mode). */
  localStore: TenantStore;
}

function embedderFor(ms: ModelService) {
  try {
    const provider = ms.router.resolve("embedding");
    const dims = Number(process.env.OPENAI_EMBED_DIMS) || 1536;
    return {
      embedder: new ModelEmbedder(provider, dims),
      label: provider.config.id,
    };
  } catch {
    return { embedder: new HashingEmbedder(), label: "hash" };
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
  private creating = new Map<string, Promise<Tenant>>();
  /** sha256(apiKey) -> tenantId. Raw keys are never stored. */
  private keyIndex = new Map<string, string>();

  async create(
    name: string,
    apiKey: string,
    id: string = randomUUID(),
    options: {
      runStore?: RunStore;
      recoverDistributedRuns?: boolean;
      distributedWorker?: boolean;
    } = {}
  ): Promise<Tenant> {
    const existing = this.tenants.get(id);
    if (existing) {
      if (apiKey) this.keyIndex.set(hashKey(apiKey), id);
      return existing;
    }

    const inFlight = this.creating.get(id);
    if (inFlight) {
      const tenant = await inFlight;
      if (apiKey) this.keyIndex.set(hashKey(apiKey), id);
      return tenant;
    }

    const creation = this.createInternal(name, apiKey, id, options);
    this.creating.set(id, creation);
    try {
      return await creation;
    } finally {
      this.creating.delete(id);
    }
  }

  private async createInternal(
    name: string,
    apiKey: string,
    id: string,
    options: {
      runStore?: RunStore;
      recoverDistributedRuns?: boolean;
      distributedWorker?: boolean;
    }
  ): Promise<Tenant> {
    const localStore = await createTenantStore(id);
    const modelService = new ModelService();

    // Restore user-added/edited models before resolving persisted routing.
    for (const cfg of await localStore.loadModels()) {
      try {
        modelService.removeModel(cfg.id);
        modelService.addModel(cfg);
      } catch (err: any) {
        console.warn(`Skipping persisted model "${cfg.id}": ${err.message}`);
      }
    }

    // Every provider is metered; hydrate usage before this tenant is exposed.
    await modelService.usage.attachStore(localStore);

    const savedRouting = await localStore.getSetting("routing");
    if (savedRouting) {
      try {
        for (const [task, modelId] of Object.entries(JSON.parse(savedRouting))) {
          const provider = modelService.registry.get(String(modelId));
          if (!provider) continue;
          if (!provider.config.capabilities[requiredCapability(task as TaskType)]) continue;
          modelService.router.setOverride(task as TaskType, String(modelId));
        }
      } catch {
        // Corrupt setting — ignore and keep env defaults.
      }
    }

    const { embedder, label } = embedderFor(modelService);
    const toolRegistry = new ToolRegistry();
    const permissionEngine = new PermissionEngine();
    const tenant: Tenant = {
      id,
      name,
      createdAt: new Date().toISOString(),
      modelService,
      indexService: new IndexService(embedder, new InMemoryVectorStore(), label),
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
      contextEngine: undefined as unknown as ContextEngine,
      agentRuntime: undefined as unknown as StreamingAgentRuntime,
      multiAgentRuntime: undefined as unknown as MultiAgentRuntime,
      currentProjectRoot: null,
      usage: { requests: 0, agentRuns: 0, indexBuilds: 0 },
      localStore,
    };

    const savedProfile = await localStore.getSetting("profile") as PermissionProfile | null;
    if (savedProfile && PROFILES[savedProfile]) tenant.toolGateway.profile = savedProfile;

    // Run event logs remain the replay/SSE substrate in this phase. The
    // durable mission/business state itself is selected by TenantStore.
    tenant.runStore = options.runStore ?? new RunStore(pathJoin(defaultDataDir(), `runs-${id}`));

    if (
      options.recoverDistributedRuns !== false &&
      distributedRuntimeReady()
    ) {
      const coordinator = getDistributedMissionCoordinator();
      for (const run of tenant.runStore.list()) {
        if (!isTerminal(run.status) && isDistributedRun(run)) {
          coordinator.ensureBridge(run.id, tenant.runStore);
        }
      }
    }

    tenant.eventBus = new EventBus(tenant.runStore);
    tenant.taskEngine = new TaskEngine(tenant.eventBus, localStore, {
      // A worker must never fail another worker's active persisted mission
      // merely because it constructed a per-job TenantManager.
      shouldFailRecoveredMission: options.distributedWorker
        ? () => false
        : (mission) => {
            const run = tenant.runStore.get(mission.runId);
            return !(
              distributedRuntimeReady() &&
              run &&
              isDistributedRun(run) &&
              !isTerminal(run.status)
            );
          },
    });
    await tenant.taskEngine.hydrate();

    tenant.contextEngine = new ContextEngine(tenant.toolGateway);
    tenant.agentRuntime = new StreamingAgentRuntime(
      tenant.modelService,
      tenant.toolGateway,
      tenant.runStore,
      tenant.checkpointEngine
    );
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
    return this.get("default") ?? await this.create("default", "", "default");
  }

  /**
   * Per-user tenant: each signed-in account gets its own isolated services
   * and its own SQLite store (user_<id>.db). Created lazily on first request.
   */
  async ensureUserTenant(userId: string, label: string): Promise<Tenant> {
    const id = `user_${userId}`;
    return this.get(id) ?? await this.create(label, "", id);
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
export async function bootstrapDefaultTenant(): Promise<Tenant> {
  const key = process.env.ORVYN_API_KEY?.trim();
  if (key) return tenantManager.create("default", key, "default");
  return tenantManager.ensureLocalDefault();
}
