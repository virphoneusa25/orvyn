// apps/backend/src/indexing/ResilientVectorStore.ts
//
// Qdrant-first, local-fallback vector store. Every operation tries Qdrant;
// if it's unreachable the operation transparently retries against the local
// NamespacedVectorStore. ORVYN remains fully usable without cloud — the
// local store just serves the reads/writes until Qdrant returns.
//
// Failover is automatic per-operation (not a one-time switch): a transient
// Qdrant blip degrades to local for that call, the next call tries Qdrant
// again via its health TTL.

import type { SearchResult, VectorRecord, VectorStore } from "./vectorStore";

export class ResilientVectorStore implements VectorStore {
  constructor(
    private primary: VectorStore,
    private fallback: VectorStore,
  ) {}

  async upsert(record: VectorRecord): Promise<void> {
    try {
      await this.primary.upsert(record);
    } catch {
      await this.fallback.upsert(record);
    }
  }

  async search(queryVector: number[], topK: number): Promise<SearchResult[]> {
    try {
      return await this.primary.search(queryVector, topK);
    } catch {
      return this.fallback.search(queryVector, topK);
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await this.primary.delete(id);
    } catch {
      await this.fallback.delete(id);
    }
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    // Both stores get the delete — keeps them consistent.
    const results = await Promise.allSettled([
      this.primary.deleteByPrefix?.(prefix),
      this.fallback.deleteByPrefix?.(prefix),
    ]);
    void results;
  }

  async clear(): Promise<void> {
    await Promise.allSettled([this.primary.clear(), this.fallback.clear()]);
  }

  async size(): Promise<number> {
    try {
      return await this.primary.size();
    } catch {
      return this.fallback.size();
    }
  }

  get usingFallback(): boolean {
    // The last operation's route — useful for truthful health reporting
    return !(this.primary as any).isHealthy;
  }

  activateProject(projectIdOrRoot: string): void {
    (this.primary as { activateProject?(id: string): void }).activateProject?.(projectIdOrRoot);
    (this.fallback as { activateProject?(id: string): void }).activateProject?.(projectIdOrRoot);
  }
}
