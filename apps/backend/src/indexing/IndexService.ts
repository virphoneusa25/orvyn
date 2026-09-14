// apps/backend/src/indexing/IndexService.ts
import { scanProject } from "./scanner";
import { chunkContent } from "./chunker";
import { Embedder } from "./embeddings";
import { VectorStore } from "./vectorStore";

export type IndexStatus = "idle" | "indexing" | "ready" | "error";

export interface IndexStats {
  status: IndexStatus;
  filesIndexed: number;
  chunksIndexed: number;
  tookMs?: number;
  lastIndexedAt?: string;
  error?: string;
}

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
}

export class IndexService {
  private stats: IndexStats = { status: "idle", filesIndexed: 0, chunksIndexed: 0 };

  constructor(private embedder: Embedder, private vectorStore: VectorStore) {}

  getStats(): IndexStats {
    return this.stats;
  }

  // NOTE: runs synchronously in the request for simplicity in this phase.
  // A production deployment should background this (a worker queue) so
  // large repos don't block the API — see master spec section 42 (don't
  // freeze the UI during indexing).
  async build(projectRoot: string): Promise<IndexStats> {
    const start = Date.now();
    this.stats = { status: "indexing", filesIndexed: 0, chunksIndexed: 0 };
    try {
      await this.vectorStore.clear();
      const files = await scanProject(projectRoot);
      let chunksIndexed = 0;

      for (const file of files) {
        const chunks = chunkContent(file.content);
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const vector = await this.embedder.embed(chunk.content);
          await this.vectorStore.upsert({
            id: `${file.relativePath}::${i}`,
            vector,
            metadata: {
              path: file.relativePath,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              snippet: chunk.content.slice(0, 500),
            },
          });
          chunksIndexed++;
        }
      }

      this.stats = {
        status: "ready",
        filesIndexed: files.length,
        chunksIndexed,
        tookMs: Date.now() - start,
        lastIndexedAt: new Date().toISOString(),
      };
    } catch (err: any) {
      this.stats = { status: "error", filesIndexed: 0, chunksIndexed: 0, error: err.message };
    }
    return this.stats;
  }

  async search(query: string, topK = 5): Promise<SearchHit[]> {
    if (this.stats.status !== "ready") return [];
    const queryVector = await this.embedder.embed(query);
    const results = await this.vectorStore.search(queryVector, topK);
    return results.map((r) => ({
      path: String(r.metadata.path),
      startLine: Number(r.metadata.startLine),
      endLine: Number(r.metadata.endLine),
      snippet: String(r.metadata.snippet),
      score: r.score,
    }));
  }
}
