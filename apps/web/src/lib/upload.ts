import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

export const MAX_UPLOAD = 7 * 1024 * 1024;

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error(`Couldn't read ${file.name}`));
    r.readAsDataURL(file);
  });
}

/** Stores files in the account (optionally in a project). Never calls a model. */
export async function uploadFiles(files: File[], opts: { projectId?: string; onProgress?: (done: number, total: number, name: string) => void } = {}): Promise<{ ok: number; skipped: string[] }> {
  let ok = 0;
  const skipped: string[] = [];
  let n = 0;
  for (const file of files) {
    opts.onProgress?.(n, files.length, file.name);
    n++;
    if (file.size > MAX_UPLOAD) { skipped.push(`${file.name} (over 7 MB)`); continue; }
    try {
      await api("/artifacts", { method: "POST", body: { name: file.name, kind: "upload", base64: await readBase64(file), mediaType: file.type || "application/octet-stream", projectId: opts.projectId } });
      ok++;
    } catch (err: any) {
      skipped.push(`${file.name} (${err.message})`);
    }
  }
  opts.onProgress?.(files.length, files.length, "");
  return { ok, skipped };
}

/** Page-wide drag and drop: returns whether files are being dragged over the window. */
export function useWindowDrop(onFiles: (files: File[]) => void, enabled = true): boolean {
  const [over, setOver] = useState(false);
  const handle = useCallback(onFiles, [onFiles]);
  useEffect(() => {
    if (!enabled) return;
    let depth = 0;
    const has = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes("Files"));
    const enter = (e: DragEvent) => { if (!has(e)) return; depth++; setOver(true); };
    const leave = (e: DragEvent) => { if (!has(e)) return; depth = Math.max(0, depth - 1); if (!depth) setOver(false); };
    const overFn = (e: DragEvent) => { if (has(e)) e.preventDefault(); };
    const drop = (e: DragEvent) => { if (!has(e)) return; e.preventDefault(); depth = 0; setOver(false); const list = Array.from(e.dataTransfer?.files ?? []); if (list.length) handle(list); };
    window.addEventListener("dragenter", enter); window.addEventListener("dragleave", leave); window.addEventListener("dragover", overFn); window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragenter", enter); window.removeEventListener("dragleave", leave); window.removeEventListener("dragover", overFn); window.removeEventListener("drop", drop); };
  }, [handle, enabled]);
  return over;
}
