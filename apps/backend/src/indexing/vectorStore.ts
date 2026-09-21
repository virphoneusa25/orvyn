// apps/backend/src/indexing/vectorStore.ts

export interface VectorRecord {
  id: string;
  vector: number[];
  metadata: Record<string, unknown>;
}

export interface SearchResult {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}

import { promises as fs } from "fs";
import * as path from "path";

// Matches the master spec's VectorStore abstraction. InMemoryVectorStore is
// the dev/default implementation (brute-force cosine similarity — fine up
// to a few tens of thousands of chunks). Production deployments should
// implement this same interface against Qdrant, pgvector, or Chroma —
// NOT IMPLEMENTED here; that's a drop-in swap behind this interface, not a
// change to any calling code.
export interface VectorStore {
  upsert(record: VectorRecord): Promise<void>;
  search(queryVector: number[], topK: number): Promise<SearchResult[]>;
  delete(id: string): Promise<void>;
  deleteByPrefix?(prefix: string): Promise<void>;
  clear(): Promise<void>;
  size(): Promise<number>;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export class InMemoryVectorStore implements VectorStore {
  private records = new Map<string, VectorRecord>();

  async upsert(record: VectorRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async search(queryVector: number[], topK: number): Promise<SearchResult[]> {
    const scored = Array.from(this.records.values()).map((r) => ({
      id: r.id,
      score: cosineSimilarity(queryVector, r.vector),
      metadata: r.metadata,
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    for (const id of [...this.records.keys()]) {
      if (id === prefix || id.startsWith(`${prefix}::`)) this.records.delete(id);
    }
  }

  async clear(): Promise<void> {
    this.records.clear();
  }

  async size(): Promise<number> {
    return this.records.size;
  }
}


/**
 * Durable local vector store for single-host OVH deployments.
 * Uses an atomic JSON snapshot so indexes survive backend restarts without
 * requiring an external database. Qdrant can replace this behind VectorStore
 * later when horizontal scale warrants it.
 */
export class PersistentVectorStore implements VectorStore {
  private records = new Map<string, VectorRecord>();
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(private filePath: string) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      for (const r of Array.isArray(raw) ? raw : []) {
        if (r?.id && Array.isArray(r.vector)) this.records.set(String(r.id), r as VectorRecord);
      }
    } catch (err: any) {
      if (err?.code !== "ENOENT") console.warn(`Vector index load failed: ${err.message}`);
    }
  }

  private persist(): Promise<void> {
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify([...this.records.values()]), "utf8");
      await fs.rename(tmp, this.filePath);
    });
    return this.writing;
  }

  async upsert(record: VectorRecord): Promise<void> {
    await this.ensureLoaded(); this.records.set(record.id, record); await this.persist();
  }
  async search(queryVector: number[], topK: number): Promise<SearchResult[]> {
    await this.ensureLoaded();
    return [...this.records.values()].map((r) => ({ id:r.id, score:cosineSimilarity(queryVector,r.vector), metadata:r.metadata }))
      .sort((a,b)=>b.score-a.score).slice(0,topK);
  }
  async delete(id: string): Promise<void> { await this.ensureLoaded(); this.records.delete(id); await this.persist(); }
  async deleteByPrefix(prefix: string): Promise<void> {
    await this.ensureLoaded();
    for (const id of [...this.records.keys()]) if (id===prefix || id.startsWith(`${prefix}::`)) this.records.delete(id);
    await this.persist();
  }
  async clear(): Promise<void> { await this.ensureLoaded(); this.records.clear(); await this.persist(); }
  async size(): Promise<number> { await this.ensureLoaded(); return this.records.size; }
}
