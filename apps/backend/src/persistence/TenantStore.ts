// apps/backend/src/persistence/TenantStore.ts

import type { ModelConfig } from "@orvyn/ai-core";
import type { Mission } from "../agent/TaskEngine";
import type { UsageEvent } from "../services/UsageService";
import { LocalStore, defaultDataDir } from "./LocalStore";
import { PostgresTenantStore } from "./PostgresTenantStore";

export type PersistenceDriver = "sqlite" | "postgres";

export interface TenantStore {
  readonly driver: PersistenceDriver;
  readonly tenantId: string;

  initialize(): Promise<void>;
  health(): Promise<boolean>;

  saveMission(mission: Mission): Promise<void>;
  loadMissions(limit?: number): Promise<Mission[]>;

  saveUsageEvent(event: UsageEvent): Promise<void>;
  countUsageSince(ts: number): Promise<number>;
  /**
   * Optional atomic quota primitive. PostgreSQL-primary implements this to
   * prevent concurrent workers from overspending the final monthly slot.
   */
  reserveUsageRequest?(
    monthStart: number,
    limit: number
  ): Promise<{ allowed: boolean; used: number }>;
  getUsageRequestCount?(monthStart: number): Promise<number>;
  countMissionsSince(ts: number): Promise<number>;
  loadRecentUsage(limit?: number): Promise<UsageEvent[]>;

  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  getToolOverrides(projectRoot: string): Promise<Record<string, string>>;
  setToolOverride(projectRoot: string, tool: string, permission: string): Promise<void>;

  saveModel(config: ModelConfig): Promise<void>;
  deleteModel(id: string): Promise<void>;
  loadModels(): Promise<ModelConfig[]>;

  close(): Promise<void>;
}

export class SQLiteTenantStore implements TenantStore {
  readonly driver = "sqlite" as const;
  readonly local: LocalStore;

  constructor(
    public readonly tenantId: string,
    dataDir: string = defaultDataDir()
  ) {
    this.local = new LocalStore(tenantId, dataDir);
  }

  async initialize(): Promise<void> {}
  async health(): Promise<boolean> { return true; }

  async saveMission(mission: Mission): Promise<void> {
    this.local.saveMission(mission);
  }
  async loadMissions(limit = 200): Promise<Mission[]> {
    return this.local.loadMissions(limit);
  }

  async saveUsageEvent(event: UsageEvent): Promise<void> {
    this.local.saveUsageEvent(event);
  }
  async countUsageSince(ts: number): Promise<number> {
    return this.local.countUsageSince(ts);
  }
  async countMissionsSince(ts: number): Promise<number> {
    return this.local.countMissionsSince(ts);
  }
  async loadRecentUsage(limit = 5000): Promise<UsageEvent[]> {
    return this.local.loadRecentUsage(limit);
  }

  async getSetting(key: string): Promise<string | null> {
    return this.local.getSetting(key);
  }
  async setSetting(key: string, value: string): Promise<void> {
    this.local.setSetting(key, value);
  }
  async getToolOverrides(projectRoot: string): Promise<Record<string, string>> {
    return this.local.getToolOverrides(projectRoot);
  }
  async setToolOverride(
    projectRoot: string,
    tool: string,
    permission: string
  ): Promise<void> {
    this.local.setToolOverride(projectRoot, tool, permission);
  }

  async saveModel(config: ModelConfig): Promise<void> {
    this.local.saveModel(config);
  }
  async deleteModel(id: string): Promise<void> {
    this.local.deleteModel(id);
  }
  async loadModels(): Promise<ModelConfig[]> {
    return this.local.loadModels();
  }

  async close(): Promise<void> {
    this.local.close();
  }
}

export function persistenceDriver(): PersistenceDriver {
  const raw = process.env.ORVYN_PERSISTENCE_DRIVER?.trim().toLowerCase();
  return raw === "postgres" ? "postgres" : "sqlite";
}

export async function createTenantStore(
  tenantId: string,
  options: { dataDir?: string } = {}
): Promise<TenantStore> {
  let store: TenantStore;

  if (persistenceDriver() === "postgres") {
    if (process.env.ORVYN_POSTGRES_CUTOVER_CONFIRMED?.trim() !== "1") {
      throw new Error(
        "ORVYN_PERSISTENCE_DRIVER=postgres requires ORVYN_POSTGRES_CUTOVER_CONFIRMED=1 after successful backfill/parity verification"
      );
    }
    if (process.env.ORVYN_POSTGRES_SHADOW?.trim() === "1") {
      throw new Error(
        "PostgreSQL authoritative mode cannot run with ORVYN_POSTGRES_SHADOW=1"
      );
    }
    const url = process.env.DATABASE_URL?.trim();
    if (!url) {
      throw new Error(
        "ORVYN_PERSISTENCE_DRIVER=postgres requires DATABASE_URL"
      );
    }
    store = new PostgresTenantStore(tenantId, url);
  } else {
    store = new SQLiteTenantStore(
      tenantId,
      options.dataDir ?? defaultDataDir()
    );
  }

  await store.initialize();
  return store;
}
