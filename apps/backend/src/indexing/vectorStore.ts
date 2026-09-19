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

function cosineSimilarity(a: number[], b: number[]): number {
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
