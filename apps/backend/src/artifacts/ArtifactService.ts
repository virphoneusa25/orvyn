import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { defaultDataDir, LocalStore } from "../persistence/LocalStore";
import { artifactStorageRoot, virtualWorkspaceRoot } from "../documents/workspace";

export type ArtifactKind = "generated" | "document" | "download" | "upload" | "run" | "file";

export interface ArtifactRecord {
  id: string;
  projectRoot?: string | null;
  runId?: string | null;
  kind: ArtifactKind;
  name: string;
  /** Display / virtual path, e.g. /artifacts/logo.png */
  path: string;
  /** Absolute file on disk. */
  diskPath: string;
  mediaType?: string | null;
  createdAt: number;
  bytes?: number;
}

export interface FilesLocation {
  id: "project" | "generated" | "downloads" | "artifacts" | "uploads";
  label: string;
  files: Array<{
    id?: string;
    name: string;
    path: string;
    kind: string;
    mediaType?: string | null;
    createdAt?: number;
    bytes?: number;
    downloadUrl?: string;
  }>;
}

const KIND_SET = new Set<ArtifactKind>(["generated", "document", "download", "upload", "run", "file"]);

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
  };
  return map[ext] ?? "application/octet-stream";
}

function asKind(value: unknown): ArtifactKind {
  const k = String(value ?? "file");
  return KIND_SET.has(k as ArtifactKind) ? (k as ArtifactKind) : "file";
}

export class ArtifactService {
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

  async ensureRoots(): Promise<void> {
    await fs.mkdir(this.virtualRoot(), { recursive: true });
    await fs.mkdir(path.join(this.virtualRoot(), "generated"), { recursive: true });
    await fs.mkdir(this.artifactsRoot(), { recursive: true });
  }

  private diskFile(id: string, name: string): string {
    return path.join(this.artifactsRoot(), id, name);
  }

  private toRecord(row: any, bytes?: number): ArtifactRecord {
    const name = String(row.name ?? "file");
    const id = String(row.id);
    const stored = String(row.path ?? "");
    const diskPath = stored && path.isAbsolute(stored) ? stored : this.diskFile(id, name);
    return {
      id,
      projectRoot: row.project_root ?? row.projectRoot ?? null,
      runId: row.run_id ?? row.runId ?? null,
      kind: asKind(row.kind),
      name,
      path: `/artifacts/${name}`,
      diskPath,
      mediaType: row.media_type ?? row.mediaType ?? mediaTypeForName(name),
      createdAt: Number(row.created_at ?? row.createdAt ?? Date.now()),
      bytes,
    };
  }

  async create(input: {
    name: string;
    kind?: string;
    bytes?: Buffer;
    content?: string;
    mediaType?: string | null;
    runId?: string | null;
    projectRoot?: string | null;
  }): Promise<ArtifactRecord> {
    await this.ensureRoots();
    const name = sanitizeArtifactName(input.name);
    const id = `art_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const kind = asKind(input.kind ?? "file");
    const bytes = input.bytes ?? Buffer.from(input.content ?? "", "utf-8");
    if (bytes.length > 12 * 1024 * 1024) throw new Error("Artifacts must be 12 MB or smaller.");
    const diskPath = this.diskFile(id, name);
    await fs.mkdir(path.dirname(diskPath), { recursive: true });
    await fs.writeFile(diskPath, bytes);
    if (kind === "generated") {
      await fs.writeFile(path.join(this.virtualRoot(), "generated", name), bytes).catch(() => undefined);
    }
    const mediaType = input.mediaType ?? mediaTypeForName(name);
    this.store.saveArtifact({
      id,
      projectRoot: input.projectRoot ?? null,
      runId: input.runId ?? null,
      kind,
      name,
      path: diskPath,
      mediaType,
    });
    return this.toRecord({ id, kind, name, path: diskPath, media_type: mediaType, project_root: input.projectRoot, run_id: input.runId, created_at: Date.now() }, bytes.length);
  }

  async write(id: string, data: Buffer | string): Promise<ArtifactRecord> {
    const current = this.store.getArtifact(id);
    if (!current) throw new Error(`Unknown artifact "${id}"`);
    const bytes = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
    if (bytes.length > 12 * 1024 * 1024) throw new Error("Artifacts must be 12 MB or smaller.");
    const name = sanitizeArtifactName(current.name);
    const diskPath = path.isAbsolute(String(current.path)) ? String(current.path) : this.diskFile(id, name);
    await fs.mkdir(path.dirname(diskPath), { recursive: true });
    await fs.writeFile(diskPath, bytes);
    this.store.saveArtifact({
      id,
      projectRoot: current.projectRoot,
      runId: current.runId,
      kind: current.kind,
      name,
      path: diskPath,
      mediaType: current.mediaType ?? mediaTypeForName(name),
    });
    return this.toRecord({ ...current, id, name, path: diskPath, media_type: current.mediaType }, bytes.length);
  }

  list(opts?: { kind?: string; projectRoot?: string | null }): ArtifactRecord[] {
    const rows = this.store.listArtifacts(undefined, 400);
    return rows
      .map((r) => this.toRecord(r))
      .filter((a) => (opts?.kind ? a.kind === opts.kind : true))
      .filter((a) => (opts?.projectRoot ? a.projectRoot === opts.projectRoot || !a.projectRoot : true));
  }

  async read(id: string): Promise<{ record: ArtifactRecord; bytes: Buffer }> {
    const row = this.store.getArtifact(id);
    if (!row) throw new Error(`Unknown artifact "${id}"`);
    const record = this.toRecord(row);
    const bytes = await fs.readFile(record.diskPath);
    record.bytes = bytes.length;
    return { record, bytes };
  }

  async delete(id: string): Promise<void> {
    const row = this.store.getArtifact(id);
    if (!row) throw new Error(`Unknown artifact "${id}"`);
    const record = this.toRecord(row);
    await fs.rm(path.dirname(record.diskPath), { recursive: true, force: true }).catch(() => undefined);
    this.store.deleteArtifact(id);
  }

  async getDownload(id: string): Promise<{ record: ArtifactRecord; bytes: Buffer; filename: string }> {
    const { record, bytes } = await this.read(id);
    return { record, bytes, filename: record.name };
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
          out.push({ name: e.name, path: nextRel, kind: "project", bytes: st?.size, createdAt: st ? Number(st.mtimeMs) : undefined });
        }
      }
    }
    await walk(root, "", 0);
    return out;
  }

  async filesTree(projectRoot?: string | null): Promise<{ locations: FilesLocation[] }> {
    await this.ensureRoots();
    const all = this.list();
    const asFile = (a: ArtifactRecord) => ({
      id: a.id,
      name: a.name,
      path: a.path,
      kind: a.kind,
      mediaType: a.mediaType,
      createdAt: a.createdAt,
      bytes: a.bytes,
      downloadUrl: `/artifacts/${a.id}/download`,
    });
    const generated = all.filter((a) => a.kind === "generated");
    const downloads = all.filter((a) => a.kind === "download");
    const uploads = all.filter((a) => a.kind === "upload");
    const runArts = all.filter((a) => a.kind === "document" || a.kind === "run" || a.kind === "file");
    const project = await this.listProjectFiles(projectRoot || this.virtualRoot());
    return {
      locations: [
        { id: "project", label: "Project", files: project },
        { id: "generated", label: "Generated", files: generated.map(asFile) },
        { id: "downloads", label: "Downloads", files: downloads.map(asFile) },
        { id: "artifacts", label: "Run Artifacts", files: runArts.map(asFile) },
        { id: "uploads", label: "Uploads", files: uploads.map(asFile) },
      ],
    };
  }
}
