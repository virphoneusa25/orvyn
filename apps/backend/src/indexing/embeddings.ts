// apps/backend/src/indexing/embeddings.ts
import { AIModelProvider } from "@orvyn/ai-core";

export interface Embedder {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}

// Wraps any configured model that implements embed() (e.g. Ollama with an
// embedding model). This is the path a real deployment should use.
export class ModelEmbedder implements Embedder {
  readonly dimensions: number;
  constructor(private provider: AIModelProvider, dimensions = 768) {
    this.dimensions = dimensions;
  }
  embed(text: string): Promise<number[]> {
    if (!this.provider.embed) throw new Error(`Model "${this.provider.config.id}" does not support embeddings`);
    return this.provider.embed(text);
  }

  embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return Promise.resolve([]);
    if (this.provider.embedMany) return this.provider.embedMany(texts);
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

// Zero-dependency fallback: a hashing-trick bag-of-words embedding. This is
// LEXICAL similarity (shared tokens), not learned semantic similarity — it
// is NOT a substitute for a real embedding model, but it makes indexing,
// chunking, storage, and ranking fully testable and useful for exact/
// near-exact term matches with no external service required.
export class HashingEmbedder implements Embedder {
  constructor(readonly dimensions = 256) {}

  embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  async embed(text: string): Promise<number[]> {
    const vector = new Array(this.dimensions).fill(0);
    const tokens = text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 1);

    for (const token of tokens) {
      const bucket = hashString(token) % this.dimensions;
      vector[bucket] += 1;
    }

    // L2-normalize so cosine similarity behaves sensibly across chunk lengths.
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vector.map((v) => v / norm);
  }
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}
