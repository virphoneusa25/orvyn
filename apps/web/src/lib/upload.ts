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
export async function uploadFiles(files: File[], opts: { projectId?: string } = {}): Promise<{ ok: number; skipped: string[] }> {
  let ok = 0;
  const skipped: string[] = [];
  for (const file of files) {
    if (file.size > MAX_UPLOAD) { skipped.push(`${file.name} (over 7 MB)`); continue; }
    try {
      await api("/artifacts", { method: "POST", body: { name: file.name, kind: "upload", base64: await readBase64(file), mediaType: file.type || "application/octet-stream", projectId: opts.projectId } });
      ok++;
    } catch (err: any) {
      skipped.push(`${file.name} (${err.message})`);
    }
  }
  return { ok, skipped };
}
