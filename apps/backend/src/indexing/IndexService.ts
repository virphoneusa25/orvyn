// apps/backend/src/indexing/IndexService.ts
import { watch, type FSWatcher, promises as fs } from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { scanProject, shouldIgnoreRelative, toPosixRelative } from "./scanner";
import { chunkFile } from "./chunker";
import { Embedder } from "./embeddings";
import { VectorStore } from "./vectorStore";
import { HybridSearch, type HybridHit } from "./HybridSearch";
import { INDEX_SCHEMA_VERSION } from "./ignoreRules";
import { gitRevision, logicalProjectId } from "./projectIdentity";
import { MAX_INDEX_FILES } from "./ignoreRules";

export type IndexStatus = "idle" | "indexing" | "ready" | "error" | "stale" | "degraded";

export interface IndexStats {
  status: IndexStatus;
  filesIndexed: number;
  filesScanned?: number;
  filesSkipped?: number;
  chunksIndexed: number;
  tookMs?: number;
  lastIndexedAt?: string;
  error?: string;
  watching?: boolean;
  embedder?: string;
  embeddingModel?: string;
  dimension?: number;
  indexVersion?: string;
  projectId?: string;
  revision?: string;
  branch?: string;
  dirty?: boolean;
  lastEvent?: { type: string; at: string; detail?: string };
  metrics?: { embedCalls: number; searchCalls: number; fallbackCount: number };
  /** Spec-facing alias: idle→not_indexed, ready→indexed. */
  state?: "not_indexed" | "indexing" | "indexed" | "stale" | "degraded" | "error";
}

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
  symbol?: string;
  reasons?: string[];
}

const EMBED_BATCH = 32;

interface FileRecord {
  fileHash: string;
  chunks: number;
}

export class IndexService {
  private stats: IndexStats = { status: "idle", filesIndexed: 0, chunksIndexed: 0 };
  private projectRoot: string | null = null;
  private projectId = "default";
  private watcher: FSWatcher | null = null;
  private pending = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private fileHashes = new Map<string, FileRecord>();
  private hybrid: HybridSearch | null = null;
  private buildGen = 0;
  private cancelled = false;
  private metrics = { embedCalls: 0, searchCalls: 0, fallbackCount: 0 };

  constructor(
    private embedder: Embedder,
    private vectorStore: VectorStore,
    private embedderLabel = "hash",
    private tenantId = "default"
  ) {
    this.stats.embedder = embedderLabel;
    this.stats.embeddingModel = embedderLabel;
    this.stats.dimension = embedder.dimensions;
    this.stats.indexVersion = INDEX_SCHEMA_VERSION;
  }

  getStats(): IndexStats {
    return {
      ...this.stats,
      watching: Boolean(this.watcher),
      embedder: this.embedderLabel,
      embeddingModel: this.embedderLabel,
      dimension: this.embedder.dimensions,
      indexVersion: INDEX_SCHEMA_VERSION,
      projectId: this.projectId,
      metrics: { ...this.metrics },
      state:
        this.stats.status === "idle"
          ? "not_indexed"
          : this.stats.status === "ready"
            ? "indexed"
            : this.stats.status,
    };
  }

  private note(type: string, detail?: string): void {
    this.stats.lastEvent = { type, at: new Date().toISOString(), detail };
  }

  get hybridSearch(): HybridSearch | null {
    return this.hybrid;
  }

  cancelBuild(): void {
    this.cancelled = true;
  }

  bindProject(projectRoot: string, explicitProjectId?: string): string {
    this.projectRoot = projectRoot;
    this.projectId = logicalProjectId(this.tenantId, projectRoot, explicitProjectId);
    (this.vectorStore as { activateProject?(id: string): void }).activateProject?.(this.projectId);
    this.hybrid = new HybridSearch({
      projectRoot,
      semanticSearch: (q, k) => this.search(q, k),
      listFiles: async () => {
        const files = await scanProject(projectRoot);
        return files.map((f) => f.relativePath);
      },
      readFile: async (rel) => fs.readFile(path.join(projectRoot, rel.split("/").join(path.sep)), "utf8"),
    });
    return this.projectId;
  }

  async build(projectRoot: string, opts: { rebuild?: boolean; projectId?: string } = {}): Promise<IndexStats> {
    const start = Date.now();
    const gen = ++this.buildGen;
    this.cancelled = false;
    this.bindProject(projectRoot, opts.projectId);
    this.stats = {
      status: "indexing",
      filesIndexed: 0,
      filesScanned: 0,
      filesSkipped: 0,
      chunksIndexed: 0,
      embedder: this.embedderLabel,
      embeddingModel: this.embedderLabel,
      dimension: this.embedder.dimensions,
      indexVersion: INDEX_SCHEMA_VERSION,
      projectId: this.projectId,
    };
    this.note("index.started", opts.rebuild ? "rebuild" : "incremental");
    try {
      const git = await gitRevision(projectRoot);
      this.stats.revision = git.revision;
      this.stats.branch = git.branch;
      this.stats.dirty = git.dirty;

      if (opts.rebuild) {
        // Force re-embed without destroying the live index first.
        this.fileHashes.clear();
      }

      const files = (await scanProject(projectRoot)).slice(0, MAX_INDEX_FILES);
      this.stats.filesScanned = files.length;
      const seen = new Set<string>();
      let chunksIndexed = 0;
      let filesIndexed = 0;

      const pending: {
        id: string;
        path: string;
        startLine: number;
        endLine: number;
        snippet: string;
        content: string;
        symbol?: string;
        symbolKind?: string;
        language?: string;
        fileHash: string;
        chunkHash: string;
      }[] = [];

      const flush = async () => {
        if (pending.length === 0) return;
        const batch = pending.splice(0, pending.length);
        this.metrics.embedCalls += batch.length;
        const vectors = await this.embedder.embedBatch(batch.map((b) => b.content));
        for (let i = 0; i < batch.length; i++) {
          if (this.cancelled || gen !== this.buildGen) return;
          await this.vectorStore.upsert({
            id: batch[i].id,
            vector: vectors[i] ?? [],
            metadata: {
              path: batch[i].path,
              relativePath: batch[i].path,
              startLine: batch[i].startLine,
              endLine: batch[i].endLine,
              snippet: batch[i].snippet,
              tenantId: this.tenantId,
              projectId: this.projectId,
              revision: this.stats.revision,
              branch: this.stats.branch,
              language: batch[i].language,
              symbol: batch[i].symbol,
              symbolKind: batch[i].symbolKind,
              chunkHash: batch[i].chunkHash,
              fileHash: batch[i].fileHash,
              indexVersion: INDEX_SCHEMA_VERSION,
              embeddingModel: this.embedderLabel,
              updatedAt: Date.now(),
            },
          });
          chunksIndexed++;
        }
      };

      for (const file of files) {
        if (this.cancelled || gen !== this.buildGen) break;
        seen.add(file.relativePath);
        const fileHash = sha(file.content);
        const prev = this.fileHashes.get(file.relativePath);
        if (!opts.rebuild && prev && prev.fileHash === fileHash) {
          filesIndexed++;
          chunksIndexed += prev.chunks;
          continue;
        }
        await this.deletePath(file.relativePath);
        const chunks = chunkFile(file.relativePath, file.content);
        this.fileHashes.set(file.relativePath, { fileHash, chunks: chunks.length });
        filesIndexed++;
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          pending.push({
            id: `${file.relativePath}::${i}`,
            path: file.relativePath,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            snippet: chunk.content.slice(0, 500),
            content: chunk.content,
            symbol: chunk.symbol,
            symbolKind: chunk.symbolKind,
            language: chunk.language,
            fileHash,
            chunkHash: sha(chunk.content),
          });
          if (pending.length >= EMBED_BATCH) await flush();
        }
      }
      await flush();

      if (!this.cancelled) {
        for (const old of [...this.fileHashes.keys()]) {
          if (!seen.has(old)) {
            await this.deletePath(old);
            this.fileHashes.delete(old);
          }
        }
      }

      if (this.cancelled && gen === this.buildGen) {
        this.note("index.cancelled");
        this.stats = { ...this.stats, status: this.fileHashes.size > 0 ? "ready" : "idle", error: "cancelled" };
        return this.getStats();
      }

      this.stats = {
        status: "ready",
        filesIndexed,
        filesScanned: files.length,
        filesSkipped: Math.max(0, (this.stats.filesScanned ?? files.length) - filesIndexed),
        chunksIndexed,
        tookMs: Date.now() - start,
        lastIndexedAt: new Date().toISOString(),
        embedder: this.embedderLabel,
        embeddingModel: this.embedderLabel,
        dimension: this.embedder.dimensions,
        indexVersion: INDEX_SCHEMA_VERSION,
        projectId: this.projectId,
        revision: git.revision,
        branch: git.branch,
        dirty: git.dirty,
      };
      this.note("index.completed", `${filesIndexed} files / ${chunksIndexed} chunks`);
      this.watch(projectRoot);
    } catch (err: any) {
      this.note("index.failed", err.message);
      this.stats = {
        ...this.stats,
        status: this.fileHashes.size > 0 ? "degraded" : "error",
        error: err.message,
        embedder: this.embedderLabel,
      };
    }
    return this.getStats();
  }

  async updateFile(relativePath: string): Promise<void> {
    if (!this.projectRoot) return;
    await this.upsertRelative(relativePath);
    this.hybrid?.noteFileChanged(relativePath);
    this.stats = { ...this.stats, status: "ready", lastIndexedAt: new Date().toISOString() };
  }

  async removeFile(relativePath: string): Promise<void> {
    await this.deletePath(relativePath);
    this.fileHashes.delete(relativePath);
    this.hybrid?.noteFileChanged(relativePath);
  }

  async renameFile(from: string, to: string): Promise<void> {
    await this.removeFile(from);
    await this.updateFile(to);
  }

  async deleteIndex(): Promise<void> {
    await this.vectorStore.clear();
    this.fileHashes.clear();
    this.unwatch();
    this.stats = {
      status: "idle",
      filesIndexed: 0,
      chunksIndexed: 0,
      embedder: this.embedderLabel,
      projectId: this.projectId,
      indexVersion: INDEX_SCHEMA_VERSION,
    };
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
    if (this.stats.status !== "ready" && this.stats.status !== "stale" && this.stats.status !== "degraded") {
      return [];
    }
    this.metrics.searchCalls++;
    try {
      const queryVector = await this.embedder.embed(query);
      const results = await this.vectorStore.search(queryVector, topK);
      return results.map((r) => ({
        path: String(r.metadata.path ?? r.metadata.relativePath ?? ""),
        startLine: Number(r.metadata.startLine),
        endLine: Number(r.metadata.endLine),
        snippet: String(r.metadata.snippet ?? ""),
        score: r.score,
        symbol: r.metadata.symbol ? String(r.metadata.symbol) : undefined,
        reasons: ["semantic"],
      }));
    } catch {
      this.metrics.fallbackCount++;
      this.stats = { ...this.stats, status: this.fileHashes.size > 0 ? "degraded" : this.stats.status };
      return [];
    }
  }

  async searchHybrid(query: string, topK = 10): Promise<HybridHit[]> {
    if (!this.hybrid) {
      if (this.projectRoot) this.bindProject(this.projectRoot);
    }
    if (!this.hybrid) return [];
    return this.hybrid.searchCodebase(query, topK);
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
        this.hybrid?.noteFileChanged(rel);
      }
      this.stats = {
        ...this.stats,
        status: "ready",
        lastIndexedAt: new Date().toISOString(),
      };
    } catch (err: any) {
      this.stats = { ...this.stats, status: "degraded", error: err.message };
    } finally {
      this.flushing = false;
      if (this.pending.size > 0) await this.flushPending();
    }
  }

  private async upsertRelative(relativePath: string): Promise<void> {
    if (!this.projectRoot) return;
    const abs = path.join(this.projectRoot, relativePath.split("/").join(path.sep));
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile() || stat.size > 500_000) {
        await this.deletePath(relativePath);
        this.fileHashes.delete(relativePath);
        return;
      }
    } catch {
      await this.deletePath(relativePath);
      this.fileHashes.delete(relativePath);
      return;
    }
    let content: string;
    try {
      content = await fs.readFile(abs, "utf-8");
    } catch {
      return;
    }
    const posix = toPosixRelative(this.projectRoot, abs);
    const fileHash = sha(content);
    const prev = this.fileHashes.get(posix);
    if (prev && prev.fileHash === fileHash) return;
    await this.deletePath(posix);
    const chunks = chunkFile(posix, content);
    if (chunks.length === 0) return;
    this.metrics.embedCalls += chunks.length;
    const vectors = await this.embedder.embedBatch(chunks.map((c) => c.content));
    for (let i = 0; i < chunks.length; i++) {
      await this.vectorStore.upsert({
        id: `${posix}::${i}`,
        vector: vectors[i] ?? [],
        metadata: {
          path: posix,
          relativePath: posix,
          startLine: chunks[i].startLine,
          endLine: chunks[i].endLine,
          snippet: chunks[i].content.slice(0, 500),
          tenantId: this.tenantId,
          projectId: this.projectId,
          language: chunks[i].language,
          symbol: chunks[i].symbol,
          symbolKind: chunks[i].symbolKind,
          chunkHash: sha(chunks[i].content),
          fileHash,
          indexVersion: INDEX_SCHEMA_VERSION,
          embeddingModel: this.embedderLabel,
          updatedAt: Date.now(),
        },
      });
    }
    this.fileHashes.set(posix, { fileHash, chunks: chunks.length });
    this.stats.filesIndexed = this.fileHashes.size;
    this.stats.chunksIndexed = [...this.fileHashes.values()].reduce((n, r) => n + r.chunks, 0);
  }

  private async deletePath(relativePath: string): Promise<void> {
    if (this.vectorStore.deleteByPrefix) {
      await this.vectorStore.deleteByPrefix(relativePath);
    }
  }
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
