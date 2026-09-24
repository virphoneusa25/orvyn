// apps/desktop/src/renderer/filesPanelModel.ts
//
// Pure model for the Workbench Files tab. It answers the one question the tab
// must never get wrong — WHERE do these files live — and shapes the lists the
// tab shows (ORION's changes first, then a real folder tree). No DOM, no IPC,
// so every rule here is unit-tested.

import type { WorkbenchEnvironment } from "./workbenchEnvironment.ts";

export type FilesLocation = "local" | "cloud" | "sandbox";

/** Where the Files tab's project files live. A cloud backend with no real
 *  project folder is Cloud, whatever the composer said. */
export function resolveFilesLocation(input: {
  environment: WorkbenchEnvironment;
  projectRoot?: string | null;
  cloudBackend: boolean;
  builtInWorkspace?: boolean;
}): FilesLocation {
  if (input.environment === "sandbox") return "sandbox";
  if (input.environment === "cloud") return "cloud";
  const hasProject = Boolean(input.projectRoot?.trim()) && !input.builtInWorkspace;
  if (input.cloudBackend && !hasProject) return "cloud";
  return "local";
}

export interface LocationCopy {
  title: string;
  detail: string;
  note: string;
  state: string;
  tone: "ok" | "warn" | "off";
}

export function locationCopy(
  loc: FilesLocation,
  opts: { projectRoot?: string | null; workerState?: "ready" | "degraded" | "offline" | null; cloudName?: string | null }
): LocationCopy {
  if (loc === "cloud") {
    return {
      title: "ORVYN Cloud",
      detail: opts.cloudName ? `Cloud workspace · ${opts.cloudName}` : "Cloud workspace",
      note: "These files are on ORVYN's servers, not your computer. Download anything you want to keep.",
      state: "Cloud",
      tone: "ok",
    };
  }
  if (loc === "sandbox") {
    return {
      title: "Sandbox on your computer",
      detail: opts.projectRoot || "Isolated Docker sandbox",
      note: "ORION works on a copy inside a Docker sandbox on your computer.",
      state: "Sandbox",
      tone: "ok",
    };
  }
  const ws = opts.workerState ?? null;
  return {
    title: "Your computer",
    detail: opts.projectRoot || "No project folder open",
    note: ws === "offline"
      ? "The ORVYN Local Worker is offline, so ORION can't work on these files right now."
      : "ORION edits these files directly on your computer. Nothing is uploaded.",
    state: ws === "offline" ? "Worker offline" : ws === "degraded" ? "Worker degraded" : "Connected",
    tone: ws === "offline" ? "off" : ws === "degraded" ? "warn" : "ok",
  };
}

/** Project-relative, forward-slash path. Absolute paths inside the root are
 *  made relative; anything else is returned normalised as-is. */
export function toProjectRelative(p: string, projectRoot?: string | null): string {
  const n = String(p ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  const root = String(projectRoot ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (root && n.toLowerCase().startsWith(root.toLowerCase() + "/")) return n.slice(root.length + 1);
  return n;
}

export function baseName(p: string): string {
  const n = String(p ?? "").replace(/\\/g, "/");
  return n.slice(n.lastIndexOf("/") + 1) || n;
}

export interface ChangedFile {
  path: string;
  name: string;
  status: "new" | "edited" | "deleted";
  additions: number;
  deletions: number;
}

/** Files ORION changed in this run, newest first, one row per path. */
export function changedByOrion(
  files: Array<{ path: string; kind?: string; status?: string; additions?: number; deletions?: number }>,
  projectRoot?: string | null
): ChangedFile[] {
  const seen = new Map<string, ChangedFile>();
  for (const f of files) {
    if (!f?.path || f.kind === "artifact") continue;
    const path = toProjectRelative(f.path, projectRoot);
    const s = String(f.status ?? f.kind ?? "").toLowerCase();
    const status: ChangedFile["status"] = /delet|remov/.test(s) ? "deleted" : /creat|new|add/.test(s) ? "new" : "edited";
    const prev = seen.get(path);
    seen.delete(path); // re-insert so the latest touch sorts first
    seen.set(path, {
      path,
      name: baseName(path),
      status: prev?.status === "new" && status === "edited" ? "new" : status,
      additions: (prev?.additions ?? 0) + Number(f.additions ?? 0),
      deletions: (prev?.deletions ?? 0) + Number(f.deletions ?? 0),
    });
  }
  return [...seen.values()].reverse();
}

export interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  bytes?: number;
  children?: TreeNode[];
}

const sortNodes = (a: TreeNode, b: TreeNode) =>
  a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.dir ? -1 : 1;

/** Folder tree from flat relative paths (Cloud listings are flat). */
export function buildTree(entries: Array<{ path: string; bytes?: number }>): TreeNode[] {
  const root: TreeNode = { name: "", path: "", dir: true, children: [] };
  for (const e of entries) {
    const parts = toProjectRelative(e.path).split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join("/");
      let child = node.children!.find((c) => c.name === part);
      if (!child) {
        child = last ? { name: part, path, dir: false, bytes: e.bytes } : { name: part, path, dir: true, children: [] };
        node.children!.push(child);
      }
      node = child;
    });
  }
  const sortDeep = (n: TreeNode) => { n.children?.sort(sortNodes); n.children?.forEach(sortDeep); };
  sortDeep(root);
  return root.children!;
}

/** One directory level from the Local disk, folders first. */
export function directoryNodes(parent: string, entries: Array<{ name: string; isDirectory: boolean; size?: number }>): TreeNode[] {
  const prefix = parent ? `${parent.replace(/\/+$/, "")}/` : "";
  return entries
    .map((e) => ({ name: e.name, path: prefix + e.name, dir: e.isDirectory, bytes: e.isDirectory ? undefined : e.size, children: e.isDirectory ? undefined : undefined }))
    .sort(sortNodes);
}

/** Paths whose name matches the query (case-insensitive), keeping parents. */
export function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  const out: TreeNode[] = [];
  for (const n of nodes) {
    if (n.dir) {
      const kids = filterTree(n.children ?? [], q);
      if (kids.length || n.name.toLowerCase().includes(q)) out.push({ ...n, children: kids.length ? kids : n.children });
    } else if (n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)) {
      out.push(n);
    }
  }
  return out;
}

export function formatBytes(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

/** Footer line under the preview: location first, so it can never mislead. */
export function previewFooter(loc: FilesLocation | "generated", parts: { type?: string; bytes?: number; changed?: ChangedFile | null }): string {
  const where = loc === "cloud" ? "In ORVYN Cloud" : loc === "sandbox" ? "In the sandbox" : loc === "generated" ? "Generated · stored in ORVYN Cloud" : "On your computer";
  const bits = [where];
  if (parts.type) bits.push(parts.type);
  const size = formatBytes(parts.bytes);
  if (size) bits.push(size);
  if (parts.changed) bits.push(parts.changed.status === "new" ? "created by ORION this run" : parts.changed.status === "deleted" ? "deleted by ORION this run" : "edited by ORION this run");
  return bits.join(" · ");
}

/** Short type label from a file name ("hello.txt" → "Text"). */
export function typeLabel(name: string, mime?: string | null): string {
  const ext = baseName(name).split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    txt: "Text", md: "Markdown", json: "JSON", js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", ts: "TypeScript", tsx: "TypeScript",
    jsx: "JavaScript", html: "HTML", css: "CSS", py: "Python", yml: "YAML", yaml: "YAML", png: "PNG image", jpg: "JPEG image",
    jpeg: "JPEG image", svg: "SVG", pdf: "PDF", csv: "CSV", sh: "Shell", php: "PHP", sql: "SQL", xml: "XML",
  };
  return map[ext] ?? (mime ? mime.split("/").pop()!.toUpperCase() : ext ? ext.toUpperCase() : "File");
}
