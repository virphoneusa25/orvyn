// apps/backend/src/checkpoint/CheckpointEngine.ts
//
// Snapshots of the working tree's DIRTY files (modified + untracked, per git
// status) under .orvyn/checkpoints/<id>/, with metadata: git HEAD, timestamp,
// optional mission/task attribution. Restore copies the snapshotted files
// back; compare reports what drifted since. Git history is never rewritten and
// nothing is ever pushed.

import { execFile } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";

export interface CheckpointMeta {
  id: string;
  projectRoot: string;
  createdAt: number;
  gitHead: string | null;
  /** False when the folder is not a git working tree at all (undo impossible). */
  gitRepo: boolean;
  note?: string;
  missionId?: string;
  taskId?: string;
  files: string[];
}

function git(projectRoot: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: projectRoot, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve({ ok: !error, out: stdout ?? "" });
    });
  });
}

function checkpointsDir(projectRoot: string): string {
  return path.join(projectRoot, ".orvyn", "checkpoints");
}

async function dirtyFiles(projectRoot: string): Promise<string[]> {
  const res = await git(projectRoot, ["status", "--porcelain"]);
  if (!res.ok) return [];
  return res.out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    // Renames show as "old -> new"; snapshot the new path.
    .map((p) => (p.includes(" -> ") ? p.split(" -> ")[1] : p))
    .map((p) => p.replace(/^"|"$/g, ""))
    .filter((p) => !p.startsWith(".orvyn/") && !p.startsWith(".orvyn\\"));
}

export class CheckpointEngine {
  async create(
    projectRoot: string,
    opts: { note?: string; missionId?: string; taskId?: string } = {}
  ): Promise<CheckpointMeta> {
    const id = `cp_${Date.now().toString(36)}`;
    const dir = path.join(checkpointsDir(projectRoot), id);
    await fs.mkdir(path.join(dir, "files"), { recursive: true });

    // Repo-ness and HEAD are separate questions: a freshly `git init`-ed
    // folder has no HEAD commit yet, but git status still works and a
    // snapshot is still meaningful.
    const inside = await git(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
    const gitRepo = inside.ok && inside.out.trim() === "true";
    const head = await git(projectRoot, ["rev-parse", "HEAD"]);
    const files = await dirtyFiles(projectRoot);

    const saved: string[] = [];
    for (const rel of files) {
      const src = path.join(projectRoot, rel);
      try {
        const stat = await fs.stat(src);
        if (!stat.isFile() || stat.size > 8 * 1024 * 1024) continue;
        const dest = path.join(dir, "files", rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(src, dest);
        saved.push(rel);
      } catch {
        // Deleted/unreadable files are simply not part of the snapshot.
      }
    }

    const meta: CheckpointMeta = {
      id,
      projectRoot,
      createdAt: Date.now(),
      gitRepo,
      gitHead: head.ok ? head.out.trim() : null,
      note: opts.note,
      missionId: opts.missionId,
      taskId: opts.taskId,
      files: saved,
    };
    await fs.writeFile(path.join(dir, "metadata.json"), JSON.stringify(meta, null, 2), "utf8");
    return meta;
  }

  async list(projectRoot: string): Promise<CheckpointMeta[]> {
    const dir = checkpointsDir(projectRoot);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }
    const metas: CheckpointMeta[] = [];
    for (const id of entries) {
      try {
        const raw = await fs.readFile(path.join(dir, id, "metadata.json"), "utf8");
        metas.push(JSON.parse(raw));
      } catch {
        // Skip half-written checkpoints.
      }
    }
    return metas.sort((a, b) => b.createdAt - a.createdAt);
  }

  private async meta(projectRoot: string, id: string): Promise<CheckpointMeta> {
    const raw = await fs.readFile(path.join(checkpointsDir(projectRoot), id, "metadata.json"), "utf8");
    return JSON.parse(raw);
  }

  /**
   * Copies every snapshotted file back over the working tree.
   *
   * With `removeCreated`, files that are dirty NOW but were NOT in the
   * snapshot are deleted — they were created after the checkpoint, so true
   * "undo" semantics require removing them, not just restoring old content.
   * Only git-dirty files inside the project are ever deleted; anything
   * committed or ignored is untouchable.
   */
  async restore(
    projectRoot: string,
    id: string,
    opts: { removeCreated?: boolean } = {}
  ): Promise<{ restored: string[]; removed?: string[] }> {
    const meta = await this.meta(projectRoot, id);
    const dir = path.join(checkpointsDir(projectRoot), id, "files");
    const restored: string[] = [];
    for (const rel of meta.files) {
      const src = path.join(dir, rel);
      const dest = path.join(projectRoot, rel);
      try {
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(src, dest);
        restored.push(rel);
      } catch {
        // Missing snapshot file — skip rather than abort a partial restore.
      }
    }

    let removed: string[] | undefined;
    if (opts.removeCreated) {
      const snapshotted = new Set(meta.files);
      const dirtyNow = await dirtyFiles(projectRoot);
      removed = [];
      for (const rel of dirtyNow) {
        if (snapshotted.has(rel)) continue;
        try {
          await fs.rm(path.join(projectRoot, rel), { force: true });
          removed.push(rel);
        } catch {
          // If it cannot be removed, leave it and report what was.
        }
      }
    }

    return { restored, removed };
  }

  /** Which snapshotted files have changed / disappeared since the checkpoint. */
  async compare(
    projectRoot: string,
    id: string
  ): Promise<{ same: string[]; changed: string[]; missing: string[] }> {
    const meta = await this.meta(projectRoot, id);
    const dir = path.join(checkpointsDir(projectRoot), id, "files");
    const same: string[] = [];
    const changed: string[] = [];
    const missing: string[] = [];
    for (const rel of meta.files) {
      try {
        const [a, b] = await Promise.all([
          fs.readFile(path.join(dir, rel)),
          fs.readFile(path.join(projectRoot, rel)),
        ]);
        if (a.equals(b)) same.push(rel);
        else changed.push(rel);
      } catch {
        missing.push(rel);
      }
    }
    return { same, changed, missing };
  }

  async delete(projectRoot: string, id: string): Promise<void> {
    if (!/^cp_[a-z0-9]+$/.test(id)) throw new Error("Invalid checkpoint id");
    await fs.rm(path.join(checkpointsDir(projectRoot), id), { recursive: true, force: true });
  }
}
