// apps/backend/src/indexing/IndexService.ts
import { watch, type FSWatcher, promises as fs } from "fs";
import * as path from "path";
import { scanProject, shouldIgnoreRelative, toPosixRelative } from "./scanner";
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
  watching?: boolean;
  embedder?: string;
}

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
}

const EMBED_BATCH = 32;
const MAX_INDEX_FILES = Number(process.env.ORVYN_MAX_INDEX_FILES) || 1200;

export class IndexService {
  private stats: IndexStats = { status: "idle", filesIndexed: 0, chunksIndexed: 0 };
  private projectRoot: string | null = null;
  private watcher: FSWatcher | null = null;
  private pending = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(
    private embedder: Embedder,
    private vectorStore: VectorStore,
    private embedderLabel = "hash"
  ) {
    this.stats.embedder = embedderLabel;
  }

  getStats(): IndexStats {
    return { ...this.stats, watching: Boolean(this.watcher), embedder: this.embedderLabel };
  }

  // NOTE: runs synchronously in the request for simplicity in this phase.
  // A production deployment should background this (a worker queue) so
  // large repos don't block the API — see master spec section 42 (don't
  // freeze the UI during indexing).
  async build(projectRoot: string): Promise<IndexStats> {
    const start = Date.now();
    this.projectRoot = projectRoot;
    this.stats = { status: "indexing", filesIndexed: 0, chunksIndexed: 0, embedder: this.embedderLabel };
    try {
      await this.vectorStore.clear();
      const files = (await scanProject(projectRoot)).slice(0, MAX_INDEX_FILES);
      const pending: { id: string; path: string; startLine: number; endLine: number; snippet: string; content: string }[] = [];
      let chunksIndexed = 0;

      const flush = async () => {
        if (pending.length === 0) return;
        const batch = pending.splice(0, pending.length);
        const vectors = await this.embedder.embedBatch(batch.map((b) => b.content));
        for (let i = 0; i < batch.length; i++) {
          await this.vectorStore.upsert({
            id: batch[i].id,
            vector: vectors[i] ?? [],
            metadata: {
              path: batch[i].path,
              startLine: batch[i].startLine,
              endLine: batch[i].endLine,
              snippet: batch[i].snippet,
            },
          });
          chunksIndexed++;
        }
      };

      for (const file of files) {
        const chunks = chunkContent(file.content);
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          pending.push({
            id: `${file.relativePath}::${i}`,
            path: file.relativePath,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            snippet: chunk.content.slice(0, 500),
            content: chunk.content,
          });
          if (pending.length >= EMBED_BATCH) await flush();
        }
      }
      await flush();

      this.stats = {
        status: "ready",
        filesIndexed: files.length,
        chunksIndexed,
        tookMs: Date.now() - start,
        lastIndexedAt: new Date().toISOString(),
        embedder: this.embedderLabel,
      };
      this.watch(projectRoot);
    } catch (err: any) {
      this.stats = { status: "error", filesIndexed: 0, chunksIndexed: 0, error: err.message, embedder: this.embedderLabel };
    }
    return this.getStats();
  }

  watch(projectRoot: string): void {
    this.unwatch();
    this.projectRoot = projectRoot;
    try {
      this.watcher = watch(projectRoot, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const rel = String(filename).split(path.sep).join("/");
        if (shouldIgnoreRelative(rel)) return;
        this.pending.add(rel);
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = setTimeout(() => {
          void this.flushPending();
        }, 500);
      });
    } catch (err: any) {
      this.stats = { ...this.stats, error: `Watcher failed: ${err.message}` };
    }
  }

  unwatch(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pending.clear();
    this.watcher?.close();
    this.watcher = null;
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

  private async flushPending(): Promise<void> {
    if (this.flushing || !this.projectRoot) return;
    const paths = [...this.pending];
    this.pending.clear();
    if (paths.length === 0) return;
    this.flushing = true;
    try {
      for (const rel of paths) {
        await this.upsertRelative(rel);
      }
      this.stats = {
        ...this.stats,
        status: "ready",
        lastIndexedAt: new Date().toISOString(),
      };
    } catch (err: any) {
      this.stats = { ...this.stats, error: err.message };
    } finally {
      this.flushing = false;
      if (this.pending.size > 0) await this.flushPending();
    }
  }

  private async upsertRelative(relativePath: string): Promise<void> {
    if (!this.projectRoot) return;
    const abs = path.join(this.projectRoot, relativePath.split("/").join(path.sep));
    await this.deletePath(relativePath);
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile() || stat.size > 500_000) return;
    } catch {
      return;
    }
    let content: string;
    try {
      content = await fs.readFile(abs, "utf-8");
    } catch {
      return;
    }
    const posix = toPosixRelative(this.projectRoot, abs);
    const chunks = chunkContent(content);
    if (chunks.length === 0) return;
    const vectors = await this.embedder.embedBatch(chunks.map((c) => c.content));
    for (let i = 0; i < chunks.length; i++) {
      await this.vectorStore.upsert({
        id: `${posix}::${i}`,
        vector: vectors[i] ?? [],
        metadata: {
          path: posix,
          startLine: chunks[i].startLine,
          endLine: chunks[i].endLine,
          snippet: chunks[i].content.slice(0, 500),
        },
      });
    }
    this.stats.filesIndexed = Math.max(this.stats.filesIndexed, 1);
    this.stats.chunksIndexed += chunks.length;
  }

  private async deletePath(relativePath: string): Promise<void> {
    if (this.vectorStore.deleteByPrefix) {
      await this.vectorStore.deleteByPrefix(relativePath);
    }
  }
}
