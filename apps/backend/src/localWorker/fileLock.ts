import { createHash } from "crypto";

interface FileLock {
  path: string;
  runId: string;
  hash: string;
  at: number;
}

const locks = new Map<string, FileLock>();

export function fileHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function acquireFileLock(path: string, runId: string, hash: string): { ok: boolean; error?: string } {
  const existing = locks.get(path);
  if (existing && existing.runId !== runId && Date.now() - existing.at < 120_000) {
    return { ok: false, error: `File is being edited by another ORION run (${existing.runId.slice(0, 8)})` };
  }
  locks.set(path, { path, runId, hash, at: Date.now() });
  return { ok: true };
}

export function releaseFileLock(path: string, runId: string): void {
  const existing = locks.get(path);
  if (existing?.runId === runId) locks.delete(path);
}

export function releaseRunLocks(runId: string): void {
  for (const [path, lock] of locks) {
    if (lock.runId === runId) locks.delete(path);
  }
}

export function expectedHash(path: string): string | undefined {
  return locks.get(path)?.hash;
}
