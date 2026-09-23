import { promises as fs } from "fs";
import path from "path";
import { createHmac, randomBytes, randomUUID } from "crypto";
import { defaultDataDir, LocalStore } from "../persistence/LocalStore";
import { artifactStorageRoot, virtualWorkspaceRoot } from "../documents/workspace";
import {
  assertNonEmpty,
  assertSizeLimit,
  isPreviewable,
  sha256Hex,
  validateBytes,
  MAX_ARTIFACT_BYTES,
} from "./bytes";
import { publicUrls, type ToolArtifactResult } from "./artifactContract";

export type ArtifactKind = "generated" | "document" | "download" | "upload" | "run" | "file";
export type ArtifactStatus = "ready" | "failed" | "deleted";

export interface ArtifactRecord {
  artifactId: string;
  /** @deprecated use artifactId */
  id: string;
  tenantId: string;
  userId?: string | null;
  chatId?: string | null;
  runId?: string | null;
  projectId?: string | null;
  projectRoot?: string | null;
  sourceTool?: string | null;
  kind: ArtifactKind;
  name: string;
  /** Display / virtual path, e.g. /artifacts/logo.png — never a filesystem path. */
  path: string;
  mimeType: string;
  /** @deprecated use mimeType */
  mediaType?: string | null;
  size: number;
  bytes?: number;
  storageBackend: "local";
  storageKey: string;
  sha256: string;
  createdAt: number;
  updatedAt: number;
  previewable: boolean;
  downloadable: boolean;
  status: ArtifactStatus;
  /** Internal only — never sent to the client. */
  diskPath?: string;
}

export interface FilesLocation {
  id: "project" | "generated" | "downloads" | "artifacts" | "uploads" | "recents";
  label: string;
  files: Array<{
    id?: string;
    artifactId?: string;
    name: string;
    path: string;
    kind: string;
    mediaType?: string | null;
    mimeType?: string | null;
    createdAt?: number;
    bytes?: number;
    size?: number;
    downloadUrl?: string;
    previewUrl?: string;
    badge?: string;
    runId?: string | null;
    sha256?: string;
  }>;
}

export interface PersistInput {
  name: string;
  kind?: string;
  bytes?: Buffer;
  content?: string;
  mediaType?: string | null;
  mimeType?: string | null;
  runId?: string | null;
  chatId?: string | null;
  projectRoot?: string | null;
  projectId?: string | null;
  sourceTool?: string | null;
  userId?: string | null;
  overwrite?: boolean;
}

const KIND_SET = new Set<ArtifactKind>(["generated", "document", "download", "upload", "run", "file"]);
const RETENTION_MS = Number(process.env.ORVYN_ARTIFACT_RETENTION_MS ?? 0);

export function sanitizeArtifactName(raw: string): string {
  const base = path.basename(String(raw || "").replace(/\\/g, "/")).trim();
  const cleaned = base.replace(/[^\p{L}\p{N} ._-]/gu, "_").replace(/\s+/g, " ").slice(0, 120);
  if (!cleaned || cleaned === "." || cleaned === "..") throw new Error("Provide a file name such as virphone-logo.png");
  return cleaned;
}

export function mediaTypeForName(name: string): string {
  const ext = path.extname(name).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".csv": "text/csv",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".json": "application/json",
    ".html": "text/html",
    ".zip": "application/zip",
  };
  return map[ext] ?? "application/octet-stream";
}

function asKind(value: unknown): ArtifactKind {
  const k = String(value ?? "file");
  return KIND_SET.has(k as ArtifactKind) ? (k as ArtifactKind) : "file";
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 40 * (i + 1)));
    }
  }
  throw last;
}

export class ArtifactService {
  private tokens = new Map<string, { artifactId: string; exp: number }>();
  private tokenSecret = process.env.ORVYN_ARTIFACT_TOKEN_SECRET?.trim() || randomBytes(24).toString("hex");

  constructor(
    private tenantId: string,
    private store: LocalStore,
    private dataDir: string = defaultDataDir()
  ) {}

  virtualRoot(): string {
    return virtualWorkspaceRoot(this.tenantId, this.dataDir);
  }

  artifactsRoot(): string {
    return artifactStorageRoot(this.tenantId, this.dataDir);
  }

  runWorkspace(runId: string): string {
    return path.join(this.virtualRoot(), "runs", sanitizeArtifactName(runId || "run"));
  }

  async ensureRoots(): Promise<void> {
    await fs.mkdir(this.virtualRoot(), { recursive: true });
    await fs.mkdir(path.join(this.virtualRoot(), "generated"), { recursive: true });
    await fs.mkdir(this.artifactsRoot(), { recursive: true });
  }

  async health(): Promise<{ healthy: boolean; detail?: string }> {
    try {
      await this.ensureRoots();
      const probe = path.join(this.artifactsRoot(), ".health");
      const stamp = String(Date.now());
      await fs.writeFile(probe, stamp);
      const read = await fs.readFile(probe, "utf-8");
      if (read !== stamp) return { healthy: false, detail: "artifact storage readback mismatch" };
      return { healthy: true, detail: "writable" };
    } catch (err: any) {
      return { healthy: false, detail: err?.message ?? "artifact storage unavailable" };
    }
  }

  private diskFile(id: string, name: string): string {
    return path.join(this.artifactsRoot(), id, name);
  }

  uniqueName(requested: string): string {
    const name = sanitizeArtifactName(requested);
    const existing = new Set(this.store.listArtifacts(undefined, 800).map((r: any) => String(r.name ?? "").toLowerCase()));
    if (!existing.has(name.toLowerCase())) return name;
    const ext = path.extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    for (let i = 2; i < 500; i++) {
      const candidate = `${stem}-${i}${ext}`;
      if (!existing.has(candidate.toLowerCase())) return candidate;
    }
    return `${stem}-${Date.now()}${ext}`;
  }

  private toRecord(row: any, size?: number): ArtifactRecord {
    const name = String(row.name ?? "file");
    const id = String(row.id ?? row.artifactId);
    const stored = String(row.path ?? row.storage_key ?? row.storageKey ?? "");
    const diskPath = stored && path.isAbsolute(stored) ? stored : this.diskFile(id, name);
    const mime = String(row.mime_type ?? row.mimeType ?? row.media_type ?? row.mediaType ?? mediaTypeForName(name));
    const bytes = Number(size ?? row.size ?? row.bytes ?? 0);
    return {
      artifactId: id,
      id,
      tenantId: String(row.tenant_id ?? row.tenantId ?? this.tenantId),
      userId: row.user_id ?? row.userId ?? null,
      chatId: row.chat_id ?? row.chatId ?? null,
      runId: row.run_id ?? row.runId ?? null,
      projectId: row.project_id ?? row.projectId ?? null,
      projectRoot: row.project_root ?? row.projectRoot ?? null,
      sourceTool: row.source_tool ?? row.sourceTool ?? null,
      kind: asKind(row.kind),
      name,
      path: `/artifacts/${name}`,
      mimeType: mime,
      mediaType: mime,
      size: bytes,
      bytes,
      storageBackend: "local",
      storageKey: `${this.tenantId}/${id}/${name}`,
      sha256: String(row.sha256 ?? ""),
      createdAt: Number(row.created_at ?? row.createdAt ?? Date.now()),
      updatedAt: Number(row.updated_at ?? row.updatedAt ?? row.created_at ?? Date.now()),
      previewable: row.previewable === 0 || row.previewable === false ? false : isPreviewable(mime),
      downloadable: row.downloadable === 0 || row.downloadable === false ? false : true,
      status: (row.status as ArtifactStatus) || "ready",
      diskPath,
    };
  }

  toPublic(record: ArtifactRecord): Omit<ArtifactRecord, "diskPath" | "storageKey"> & ToolArtifactResult & { downloadUrl: string; previewUrl?: string } {
    const { diskPath: _d, storageKey: _k, ...rest } = record;
    const urls = publicUrls(record.artifactId, record.previewable);
    return {
      ...rest,
      artifactId: record.artifactId,
      name: record.name,
      mimeType: record.mimeType,
      size: record.size,
      sha256: record.sha256,
      ...urls,
    };
  }

  toToolResult(record: ArtifactRecord): ToolArtifactResult {
    const urls = publicUrls(record.artifactId, record.previewable);
    return {
      artifactId: record.artifactId,
      name: record.name,
      mimeType: record.mimeType,
      size: record.size,
      sha256: record.sha256,
      kind: record.kind,
      ...urls,
    };
  }

  async persistArtifact(input: PersistInput): Promise<ArtifactRecord> {
    const health = await this.health();
    if (!health.healthy) throw new Error(`Artifact storage unavailable: ${health.detail ?? "degraded"}`);
    await this.ensureRoots();
    const requested = sanitizeArtifactName(input.name);
    const name = input.overwrite ? requested : this.uniqueName(requested);
    const id = `art_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const kind = asKind(input.kind ?? "file");
    const raw = input.bytes ?? Buffer.from(input.content ?? "", "utf-8");
    assertNonEmpty(raw);
    assertSizeLimit(raw);
    const declared = input.mimeType ?? input.mediaType ?? mediaTypeForName(name);
    const mimeType = validateBytes(name, declared, raw);
    const sha256 = sha256Hex(raw);
    const diskPath = this.diskFile(id, name);
    await withRetry(async () => {
      await fs.mkdir(path.dirname(diskPath), { recursive: true });
      const tmp = `${diskPath}.tmp-${randomUUID().slice(0, 8)}`;
      await fs.writeFile(tmp, raw);
      await fs.rename(tmp, diskPath);
    });
    try {
      this.store.saveArtifactStrict({
        id,
        tenantId: this.tenantId,
        projectRoot: input.projectRoot ?? null,
        projectId: input.projectId ?? null,
        runId: input.runId ?? null,
        chatId: input.chatId ?? null,
        sourceTool: input.sourceTool ?? null,
        userId: input.userId ?? null,
        kind,
        name,
        path: diskPath,
        mediaType: mimeType,
        sha256,
        size: raw.length,
        status: "ready",
        previewable: isPreviewable(mimeType),
        downloadable: true,
      });
    } catch (err) {
      await fs.rm(path.dirname(diskPath), { recursive: true, force: true }).catch(() => undefined);
      throw err instanceof Error ? err : new Error("Failed to register artifact metadata.");
    }
    if (kind === "generated") {
      await fs.writeFile(path.join(this.virtualRoot(), "generated", name), raw).catch(() => undefined);
    }
    return this.toRecord(
      {
        id,
        kind,
        name,
        path: diskPath,
        media_type: mimeType,
        project_root: input.projectRoot,
        run_id: input.runId,
        chat_id: input.chatId,
        source_tool: input.sourceTool,
        tenant_id: this.tenantId,
        sha256,
        size: raw.length,
        created_at: Date.now(),
        updated_at: Date.now(),
        status: "ready",
      },
      raw.length
    );
  }

  createArtifact(input: PersistInput): Promise<ArtifactRecord> {
    return this.persistArtifact(input);
  }

  create(input: PersistInput): Promise<ArtifactRecord> {
    return this.persistArtifact(input);
  }

  async writeArtifact(id: string, data: Buffer | string): Promise<ArtifactRecord> {
    const current = this.store.getArtifact(id);
    if (!current) throw new Error(`Unknown artifact "${id}"`);
    const bytes = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
    assertNonEmpty(bytes);
    assertSizeLimit(bytes);
    const name = sanitizeArtifactName(current.name);
    const mimeType = validateBytes(name, current.mediaType ?? mediaTypeForName(name), bytes);
    const diskPath = path.isAbsolute(String(current.path)) ? String(current.path) : this.diskFile(id, name);
    const sha256 = sha256Hex(bytes);
    await withRetry(async () => {
      await fs.mkdir(path.dirname(diskPath), { recursive: true });
      const tmp = `${diskPath}.tmp-${randomUUID().slice(0, 8)}`;
      await fs.writeFile(tmp, bytes);
      await fs.rename(tmp, diskPath);
    });
    this.store.saveArtifactStrict({
      id,
      tenantId: this.tenantId,
      projectRoot: current.projectRoot,
      runId: current.runId,
      chatId: current.chatId,
      sourceTool: current.sourceTool,
      kind: current.kind,
      name,
      path: diskPath,
      mediaType: mimeType,
      sha256,
      size: bytes.length,
      status: "ready",
      previewable: isPreviewable(mimeType),
      downloadable: true,
    });
    return this.toRecord({ ...current, id, name, path: diskPath, media_type: mimeType, sha256, size: bytes.length }, bytes.length);
  }

  write(id: string, data: Buffer | string): Promise<ArtifactRecord> {
    return this.writeArtifact(id, data);
  }

  registerArtifact(record: ArtifactRecord): ArtifactRecord {
    if (!record.artifactId && !record.id) throw new Error("Cannot register an artifact without artifactId.");
    this.store.saveArtifactStrict({
      id: record.artifactId || record.id,
      tenantId: this.tenantId,
      projectRoot: record.projectRoot,
      runId: record.runId,
      chatId: record.chatId,
      sourceTool: record.sourceTool,
      kind: record.kind,
      name: record.name,
      path: record.diskPath || this.diskFile(record.artifactId || record.id, record.name),
      mediaType: record.mimeType,
      sha256: record.sha256,
      size: record.size,
      status: record.status,
      previewable: record.previewable,
      downloadable: record.downloadable,
    });
    return record;
  }

  getArtifact(id: string): ArtifactRecord | null {
    const row = this.store.getArtifact(id);
    return row ? this.toRecord(row) : null;
  }

  listArtifacts(opts?: { kind?: string; projectRoot?: string | null; chatId?: string | null; runId?: string | null }): ArtifactRecord[] {
    const rows = this.store.listArtifacts(undefined, 400);
    const now = Date.now();
    return rows
      .map((r) => this.toRecord(r))
      .filter((a) => a.status !== "deleted")
      .filter((a) => (opts?.kind ? a.kind === opts.kind : true))
      .filter((a) => (opts?.projectRoot ? a.projectRoot === opts.projectRoot || !a.projectRoot : true))
      .filter((a) => (opts?.chatId ? a.chatId === opts.chatId : true))
      .filter((a) => (opts?.runId ? a.runId === opts.runId : true))
      .filter((a) => (RETENTION_MS > 0 ? now - a.createdAt < RETENTION_MS : true));
  }

  list(opts?: { kind?: string; projectRoot?: string | null }): ArtifactRecord[] {
    return this.listArtifacts(opts);
  }

  search(query: string): ArtifactRecord[] {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return this.listArtifacts();
    return this.listArtifacts().filter((a) =>
      a.name.toLowerCase().includes(q) ||
      a.mimeType.toLowerCase().includes(q) ||
      (a.chatId ?? "").toLowerCase().includes(q) ||
      (a.runId ?? "").toLowerCase().includes(q) ||
      (a.sourceTool ?? "").toLowerCase().includes(q) ||
      a.kind.toLowerCase().includes(q)
    );
  }

  recents(limit = 20): ArtifactRecord[] {
    return this.listArtifacts().sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  async read(id: string): Promise<{ record: ArtifactRecord; bytes: Buffer }> {
    const row = this.store.getArtifact(id);
    if (!row) throw new Error(`Unknown artifact "${id}"`);
    const record = this.toRecord(row);
    const bytes = await fs.readFile(record.diskPath!);
    record.size = bytes.length;
    record.bytes = bytes.length;
    return { record, bytes };
  }

  async deleteArtifact(id: string): Promise<void> {
    const row = this.store.getArtifact(id);
    if (!row) throw new Error(`Unknown artifact "${id}"`);
    const record = this.toRecord(row);
    await fs.rm(path.dirname(record.diskPath!), { recursive: true, force: true }).catch(() => undefined);
    this.store.deleteArtifact(id);
  }

  async delete(id: string): Promise<void> {
    return this.deleteArtifact(id);
  }

  async getDownload(id: string): Promise<{ record: ArtifactRecord; bytes: Buffer; filename: string }> {
    const { record, bytes } = await this.read(id);
    if (!record.downloadable) throw new Error("This artifact is not downloadable.");
    return { record, bytes, filename: record.name };
  }

  async previewArtifact(id: string): Promise<{ record: ArtifactRecord; bytes: Buffer; filename: string }> {
    const { record, bytes } = await this.read(id);
    if (!record.previewable) throw new Error("This artifact is not previewable.");
    return { record, bytes, filename: record.name };
  }

  createDownloadToken(artifactId: string, ttlMs = 15 * 60 * 1000): { token: string; expiresAt: number; url: string } {
    if (!this.getArtifact(artifactId)) throw new Error(`Unknown artifact "${artifactId}"`);
    const exp = Date.now() + ttlMs;
    const token = createHmac("sha256", this.tokenSecret).update(`${this.tenantId}:${artifactId}:${exp}`).digest("hex").slice(0, 32);
    this.tokens.set(token, { artifactId, exp });
    return { token, expiresAt: exp, url: `/artifacts/${artifactId}/download?token=${token}` };
  }

  resolveDownload(token: string): string {
    const row = this.tokens.get(token);
    if (!row || row.exp < Date.now()) throw new Error("Download token expired or invalid.");
    return row.artifactId;
  }

  async promoteToArtifact(
    filePath: string,
    metadata: { name?: string; kind?: string; mimeType?: string; runId?: string | null; chatId?: string | null; sourceTool?: string | null; projectRoot?: string | null }
  ): Promise<ArtifactRecord> {
    const bytes = await fs.readFile(filePath);
    return this.persistArtifact({
      name: metadata.name ?? path.basename(filePath),
      kind: metadata.kind ?? "generated",
      bytes,
      mimeType: metadata.mimeType,
      runId: metadata.runId,
      chatId: metadata.chatId,
      sourceTool: metadata.sourceTool,
      projectRoot: metadata.projectRoot,
    });
  }

  async persistZip(
    name: string,
    files: Array<{ name: string; content: string | Buffer }>,
    meta?: { runId?: string | null; chatId?: string | null; sourceTool?: string | null }
  ): Promise<ArtifactRecord> {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    if (!files.length) throw new Error("ZIP needs at least one file.");
    for (const f of files) {
      const n = sanitizeArtifactName(f.name);
      zip.file(n, typeof f.content === "string" ? f.content : f.content);
    }
    const bytes = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
    const zipName = sanitizeArtifactName(name.endsWith(".zip") ? name : `${name}.zip`);
    return this.persistArtifact({
      name: zipName,
      kind: "generated",
      bytes,
      mimeType: "application/zip",
      runId: meta?.runId,
      chatId: meta?.chatId,
      sourceTool: meta?.sourceTool ?? "create_zip",
    });
  }

  async listProjectFiles(projectRoot?: string | null, max = 80): Promise<FilesLocation["files"]> {
    const root = projectRoot || this.virtualRoot();
    await fs.mkdir(root, { recursive: true });
    const out: FilesLocation["files"] = [];
    const skip = new Set(["node_modules", ".git", "dist", "build", "coverage", ".orvyn"]);
    async function walk(dir: string, rel: string, depth: number): Promise<void> {
      if (out.length >= max || depth > 3) return;
      let entries: import("fs").Dirent[] = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= max) return;
        if (skip.has(e.name) || e.name.startsWith(".")) continue;
        const nextRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), nextRel, depth + 1);
        else {
          const st = await fs.stat(path.join(dir, e.name)).catch(() => null);
          out.push({ name: e.name, path: nextRel, kind: "project", bytes: st?.size, createdAt: st ? Number(st.mtimeMs) : undefined, badge: "Project" });
        }
      }
    }
    await walk(root, "", 0);
    return out;
  }

  private asFile(a: ArtifactRecord, badge: string) {
    const urls = publicUrls(a.artifactId, a.previewable);
    return {
      id: a.artifactId,
      artifactId: a.artifactId,
      name: a.name,
      path: a.path,
      kind: a.kind,
      mediaType: a.mimeType,
      mimeType: a.mimeType,
      createdAt: a.createdAt,
      bytes: a.size,
      size: a.size,
      badge,
      runId: a.runId,
      sha256: a.sha256,
      downloadUrl: urls.downloadUrl,
      previewUrl: urls.previewUrl,
    };
  }

  async filesTree(projectRoot?: string | null): Promise<{ locations: FilesLocation[] }> {
    await this.ensureRoots();
    const all = this.listArtifacts();
    const generated = all.filter((a) => a.kind === "generated");
    const downloads = all.filter((a) => a.kind === "download");
    const uploads = all.filter((a) => a.kind === "upload");
    const runArts = all.filter((a) => a.kind === "document" || a.kind === "run" || a.kind === "file");
    const project = await this.listProjectFiles(projectRoot || this.virtualRoot());
    return {
      locations: [
        { id: "project", label: "Project", files: project },
        { id: "generated", label: "Generated", files: generated.map((a) => this.asFile(a, "Generated")) },
        { id: "recents", label: "Recents", files: this.recents(24).map((a) => this.asFile(a, a.kind === "generated" ? "Generated" : "Artifact")) },
        { id: "downloads", label: "Downloads", files: downloads.map((a) => this.asFile(a, "Download")) },
        { id: "artifacts", label: "Run Artifacts", files: runArts.map((a) => this.asFile(a, "Run")) },
        { id: "uploads", label: "Uploads", files: uploads.map((a) => this.asFile(a, "Upload")) },
      ],
    };
  }
}

export const ARTIFACT_MAX_BYTES = MAX_ARTIFACT_BYTES;
