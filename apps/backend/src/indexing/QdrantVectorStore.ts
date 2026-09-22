// apps/backend/src/indexing/QdrantVectorStore.ts
//
// Qdrant-backed vector store for scalable remote project intelligence.
// Implements the same VectorStore interface as the local stores — a drop-in
// upgrade behind IndexService. Every record carries tenantId + projectId
// so multi-tenant isolation is enforced at the vector level, and the
// active project namespace scopes search/upsert/delete/clear.

import { createHash } from "crypto";
import type { SearchResult, VectorRecord, VectorStore } from "./vectorStore";

interface QdrantConfig {
  url: string;          // e.g. http://qdrant:6333
  collection: string;   // e.g. orvyn_code
  apiKey?: string;
  /** Must match the embedder. Never mix dimensions in one collection. */
  dimension?: number;
}

interface ScopedMetadata extends Record<string, unknown> {
  tenantId: string;
  projectId: string;
  relativePath?: string;
  language?: string;
  symbol?: string;
  symbolType?: string;
  chunkId?: string;
  contentHash?: string;
  startLine?: number;
  endLine?: number;
  updatedAt?: number;
  [key: string]: unknown;
}

interface ScopedRecord extends VectorRecord {
  metadata: ScopedMetadata;
}

export class QdrantVectorStore implements VectorStore {
  private collection: string;
  private url: string;
  private apiKey?: string;
  private tenantId: string;
  private projectId: string;
  private dimension: number;
  private healthy = false;
  private healthCheckedAt = 0;
  private readonly HEALTH_TTL = 30_000; // re-check health every 30s

  constructor(config: QdrantConfig, tenantId: string, projectId: string) {
    this.url = config.url.replace(/\/$/, "");
    this.collection = config.collection;
    this.apiKey = config.apiKey;
    this.tenantId = tenantId;
    this.projectId = projectId;
    this.dimension = config.dimension ?? 256;
  }

  /** Switch the active project namespace without creating a second collection. */
  activateProject(projectId: string): void {
    if (projectId) this.projectId = projectId;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["api-key"] = this.apiKey;
    return h;
  }

  private async ensureCollection(): Promise<void> {
    // Idempotent: creating an existing collection is a no-op
    const res = await fetch(`${this.url}/collections/${this.collection}`, {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify({
        vectors: { size: this.dimension, distance: "Cosine" },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Qdrant collection create failed: ${res.status} ${body.slice(0, 200)}`);
    }
  }

  private async checkHealth(): Promise<boolean> {
    const now = Date.now();
    if (now - this.healthCheckedAt < this.HEALTH_TTL) return this.healthy;
    this.healthCheckedAt = now;
    try {
      const res = await fetch(`${this.url}/healthz`, { signal: AbortSignal.timeout(3000) });
      this.healthy = res.ok;
    } catch {
      this.healthy = false;
    }
    return this.healthy;
  }

  /**
   * Qdrant requires point IDs to be integers or UUIDs — NOT arbitrary strings.
   * We derive a deterministic UUID from the scoped logical ID so re-upserting
   * the same chunk updates the same point (idempotent).
   */
  private static scopedUuid(scopedId: string): string {
    const hash = createHash("sha1").update(scopedId).digest("hex");
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  }

  private scopedId(id: string): string {
    return `${this.tenantId}_${this.projectId}_${id}`;
  }

  async upsert(record: ScopedRecord): Promise<void> {
    if (!(await this.checkHealth())) throw new Error("Qdrant unavailable");
    await this.ensureCollection();
    const scopedId = this.scopedId(record.id);
    const res = await fetch(`${this.url}/collections/${this.collection}/points`, {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify({
        points: [
          {
            id: QdrantVectorStore.scopedUuid(scopedId),
            vector: record.vector,
            payload: {
              ...record.metadata,
              tenantId: this.tenantId,
              projectId: this.projectId,
              logicalId: record.id, // the un-scoped ID callers know about
            },
          },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Qdrant upsert failed: ${res.status}`);
  }

  async search(queryVector: number[], topK: number): Promise<SearchResult[]> {
    if (!(await this.checkHealth())) throw new Error("Qdrant unavailable");
    const res = await fetch(`${this.url}/collections/${this.collection}/points/search`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        vector: queryVector,
        limit: topK,
        filter: {
          must: [
            { key: "tenantId", match: { value: this.tenantId } },
            { key: "projectId", match: { value: this.projectId } },
          ],
        },
        with_payload: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Qdrant search failed: ${res.status}`);
    const data = await res.json();
    return (data.result ?? []).map((r: any) => ({
      id: r.payload?.logicalId ?? String(r.id),
      score: r.score,
      metadata: r.payload ?? {},
    }));
  }

  async delete(id: string): Promise<void> {
    if (!(await this.checkHealth())) throw new Error("Qdrant unavailable");
    await fetch(`${this.url}/collections/${this.collection}/points/delete`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ points: [QdrantVectorStore.scopedUuid(this.scopedId(id))] }),
      signal: AbortSignal.timeout(5000),
    });
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    // Delete all points for this file (prefix = relative path)
    if (!(await this.checkHealth())) throw new Error("Qdrant unavailable");
    await fetch(`${this.url}/collections/${this.collection}/points/delete`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        filter: {
          must: [
            { key: "tenantId", match: { value: this.tenantId } },
            { key: "projectId", match: { value: this.projectId } },
            { key: "relativePath", match: { value: prefix } },
          ],
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
  }

  async clear(): Promise<void> {
    // Clear ONLY this project's points (tenant+project scoped)
    if (!(await this.checkHealth())) throw new Error("Qdrant unavailable");
    await fetch(`${this.url}/collections/${this.collection}/points/delete`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        filter: {
          must: [
            { key: "tenantId", match: { value: this.tenantId } },
            { key: "projectId", match: { value: this.projectId } },
          ],
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
  }

  async size(): Promise<number> {
    if (!(await this.checkHealth())) throw new Error("Qdrant unavailable");
    const res = await fetch(`${this.url}/collections/${this.collection}/points/count`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        filter: {
          must: [
            { key: "tenantId", match: { value: this.tenantId } },
            { key: "projectId", match: { value: this.projectId } },
          ],
        },
        exact: false,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return 0;
    const data = await res.json();
    return data.result?.count ?? 0;
  }

  get isHealthy(): boolean {
    return this.healthy;
  }
}
