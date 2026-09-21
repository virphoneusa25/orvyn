// apps/backend/src/indexing/NamespacedVectorStore.ts
//
// Project-namespaced vector storage. Every record belongs to a project
// namespace derived from the normalized project root, so:
//   - rebuilding Project A never touches Project B's index
//   - searches are scoped to the active project (no cross-project leakage)
//   - a single persistent file backs all projects with per-namespace
//     invalidation (file-level incremental updates)
//
// The namespace is a stable hash of the normalized absolute root, so the
// same project checked out at the same path always maps to the same
// namespace across restarts.

import { createHash } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import type { SearchResult, VectorRecord, VectorStore } from "./vectorStore";
import { cosineSimilarity } from "./vectorStore";

/** Stable namespace for a project root. */
export function projectNamespace(projectRoot: string): string {
  const normalized = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return `p_${createHash("sha1").update(normalized).digest("hex").slice(0, 12)}`;
}

export interface NamespacedRecord extends VectorRecord {
  /** Set by this store — callers never manage namespaces directly. */
  metadata: Record<string, unknown>;
}

export class NamespacedVectorStore implements VectorStore {
  /** namespace → Map(recordId → record) */
  private projects = new Map<string, Map<string, VectorRecord>>();
  private loadPromise: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private activeNamespace: string | null = null;

  constructor(private filePath: string) {}

  /** Activate a project namespace — searches and upserts scope to it. */
  activateProject(projectRoot: string): void {
    this.activeNamespace = projectNamespace(projectRoot);
    void this.ensureLoaded();
  }

  get activeProject(): string | null {
    return this.activeNamespace;
  }

  /** Authoritative: does a usable index exist for the active project? */
  hasIndex(projectRoot?: string): boolean {
    const ns = projectRoot ? projectNamespace(projectRoot) : this.activeNamespace;
    if (!ns) return false;
    return (this.projects.get(ns)?.size ?? 0) > 0;
  }

  projectStats(projectRoot?: string): { chunks: number; files: number } {
    const ns = projectRoot ? projectNamespace(projectRoot) : this.activeNamespace;
    if (!ns) return { chunks: 0, files: 0 };
    const records = this.projects.get(ns);
    if (!records) return { chunks: 0, files: 0 };
    const files = new Set([...records.values()].map((r) => String(r.metadata.relativePath ?? "")));
    return { chunks: records.size, files: files.size };
  }

  private ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const raw = JSON.parse(await fs.readFile(this.filePath, "utf8"));
          for (const entry of Array.isArray(raw) ? raw : []) {
            const ns = String(entry?.ns ?? "");
            if (!ns || !Array.isArray(entry?.records)) continue;
            const map = this.projects.get(ns) ?? new Map<string, VectorRecord>();
            for (const r of entry.records) {
              if (r?.id && Array.isArray(r.vector)) map.set(String(r.id), r as VectorRecord);
            }
            this.projects.set(ns, map);
          }
        } catch (err: any) {
          if (err?.code !== "ENOENT") console.warn(`Project index load failed: ${err.message}`);
        }
      })();
    }
    return this.loadPromise;
  }

  private persist(): Promise<void> {
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const dump = [...this.projects.entries()].map(([ns, map]) => ({ ns, records: [...map.values()] }));
      const tmp = `${this.filePath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(dump), "utf8");
      await fs.rename(tmp, this.filePath);
    });
    return this.writing;
  }

  async upsert(record: VectorRecord): Promise<void> {
    await this.ensureLoaded();
    const ns = this.activeNamespace ?? "default";
    const map = this.projects.get(ns) ?? new Map<string, VectorRecord>();
    map.set(record.id, record);
    this.projects.set(ns, map);
    await this.persist();
  }

  async search(queryVector: number[], topK: number): Promise<SearchResult[]> {
    await this.ensureLoaded();
    const ns = this.activeNamespace ?? "default";
    const records = this.projects.get(ns);
    if (!records) return [];
    return [...records.values()]
      .map((r) => ({ id: r.id, score: cosineSimilarity(queryVector, r.vector), metadata: r.metadata }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async delete(id: string): Promise<void> {
    await this.ensureLoaded();
    const ns = this.activeNamespace ?? "default";
    this.projects.get(ns)?.delete(id);
    await this.persist();
  }

  /** Invalidate ONLY one file's chunks in the active project (incremental). */
  async deleteByPrefix(prefix: string): Promise<void> {
    await this.ensureLoaded();
    const ns = this.activeNamespace ?? "default";
    const map = this.projects.get(ns);
    if (!map) return;
    for (const id of [...map.keys()]) {
      if (id === prefix || id.startsWith(`${prefix}::`)) map.delete(id);
    }
    await this.persist();
  }

  /** Invalidate a specific file by relativePath metadata (incremental). */
  async invalidateFile(relativePath: string): Promise<void> {
    await this.ensureLoaded();
    const ns = this.activeNamespace ?? "default";
    const map = this.projects.get(ns);
    if (!map) return;
    // Records are keyed as `${ns}:${relativePath}:${chunkIdx}` by the
    // IndexService; invalidate by metadata match is safest across formats.
    for (const [id, r] of [...map.entries()]) {
      if (String(r.metadata.relativePath ?? "") === relativePath) map.delete(id);
    }
    await this.persist();
  }

  /** Clears ONLY the active project — other projects untouched. */
  async clear(): Promise<void> {
    await this.ensureLoaded();
    if (this.activeNamespace) this.projects.delete(this.activeNamespace);
    await this.persist();
  }

  async size(): Promise<number> {
    await this.ensureLoaded();
    return this.projects.get(this.activeNamespace ?? "default")?.size ?? 0;
  }
}
