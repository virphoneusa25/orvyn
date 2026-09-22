// IDE workbench tabs. One region, many tabs, never a second column.

export type WorkbenchTabKind =
  | "changes"
  | "desktop"
  | "browser"
  | "preview"
  | "files"
  | "diff"
  | "terminal"
  | "review"
  | "artifact"
  | "file"
  | "plan"
  | "docs";

export interface WorkbenchTab {
  id: string;
  kind: WorkbenchTabKind;
  title: string;
  closable: boolean;
  url?: string;
  path?: string;
}

export const WORKBENCH_TEST_ID = "agent-workbench";
export const WORKBENCH_TABBAR_TEST_ID = "agent-workbench-tabbar";

export function previewTabId(url: string): string {
  return `preview:${url}`;
}

export function fileTabId(path: string): string {
  return `file:${path}`;
}

export function diffTabId(path: string): string {
  return `diff:${path}`;
}

export function artifactTabId(name: string): string {
  return `artifact:${name}`;
}

export function truncateTabTitle(title: string, max = 28): string {
  const t = title.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export function previewTitle(url: string, projectName?: string | null): string {
  try {
    const u = new URL(url);
    const port = u.port ? `:${u.port}` : "";
    const name = (projectName || "ORVYN").slice(0, 18);
    return `${name} ${port}`.trim();
  } catch {
    return "Preview";
  }
}

export function fileTitle(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}

export function parseWorkbenchTab(id: string): WorkbenchTab {
  if (id.startsWith("preview:")) {
    const url = id.slice("preview:".length);
    return { id, kind: "preview", title: previewTitle(url), closable: true, url };
  }
  if (id.startsWith("file:")) {
    const path = id.slice("file:".length);
    return { id, kind: "file", title: fileTitle(path), closable: true, path };
  }
  if (id.startsWith("diff:")) {
    const path = id.slice("diff:".length);
    return { id, kind: "diff", title: `${fileTitle(path)} — Diff`, closable: true, path };
  }
  if (id.startsWith("artifact:")) {
    const path = id.slice("artifact:".length);
    return { id, kind: "artifact", title: fileTitle(path), closable: true, path };
  }
  if (id.startsWith("browser:")) {
    return { id, kind: "browser", title: "Browser", closable: true };
  }
  const pinned: Record<string, WorkbenchTab> = {
    changes: { id: "changes", kind: "changes", title: "Changes", closable: false },
    desktop: { id: "desktop", kind: "desktop", title: "Desktop", closable: true },
    browser: { id: "browser", kind: "browser", title: "Browser", closable: false },
    files: { id: "files", kind: "files", title: "Files", closable: true },
    terminal: { id: "terminal", kind: "terminal", title: "Terminal", closable: true },
    review: { id: "review", kind: "review", title: "Review", closable: true },
    plan: { id: "plan", kind: "plan", title: "Plan", closable: true },
    docs: { id: "docs", kind: "docs", title: "Docs", closable: true },
  };
  return pinned[id] ?? { id: "changes", kind: "changes", title: "Changes", closable: false };
}

export function upsertTab(tabs: WorkbenchTab[], tab: WorkbenchTab): WorkbenchTab[] {
  if (tabs.some((t) => t.id === tab.id)) return tabs;
  return [...tabs, tab];
}

export function closeTab(tabs: WorkbenchTab[], id: string, activeId: string): { tabs: WorkbenchTab[]; activeId: string } {
  const next = tabs.filter((t) => t.id !== id || !t.closable);
  if (next.length === tabs.length) return { tabs, activeId };
  if (activeId !== id) return { tabs: next, activeId };
  const idx = tabs.findIndex((t) => t.id === id);
  const fallback = next[Math.max(0, idx - 1)] ?? next[0];
  return { tabs: next, activeId: fallback?.id ?? "changes" };
}

export function rememberUrl(recents: string[], url: string, limit = 8): string[] {
  if (!url || !/^https?:\/\//i.test(url)) return recents;
  const next = [url, ...recents.filter((u) => u !== url)];
  return next.slice(0, limit);
}

export function followWorkbenchTab(kind: WorkbenchTabKind, extras?: { url?: string; path?: string; name?: string; browserId?: string }): WorkbenchTab {
  if (kind === "preview" && extras?.url) return parseWorkbenchTab(previewTabId(extras.url));
  if (kind === "browser" && extras?.browserId) return parseWorkbenchTab(`browser:${extras.browserId}`);
  if (kind === "diff" && extras?.path) return parseWorkbenchTab(diffTabId(extras.path));
  if (kind === "file" && extras?.path) return parseWorkbenchTab(fileTabId(extras.path));
  if (kind === "artifact" && extras?.name) return parseWorkbenchTab(artifactTabId(extras.name));
  return parseWorkbenchTab(kind);
}

export function workbenchMarkupContract(html: string): { workbenches: number; inspectors: number; tabbars: number } {
  return {
    workbenches: (html.match(/data-testid="agent-workbench"/g) ?? []).length,
    inspectors: (html.match(/data-testid="inspector-panel"/g) ?? []).length,
    tabbars: (html.match(/data-testid="agent-workbench-tabbar"/g) ?? []).length,
  };
}
