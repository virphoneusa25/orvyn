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
  | "docs"
  | "environment";

export const WORKBENCH_LAUNCHERS: { id: "changes" | "browser" | "terminal" | "files"; label: string; hint: string }[] = [
  { id: "changes", label: "Changes", hint: "View and manage code changes" },
  { id: "browser", label: "Browser", hint: "Open websites and web apps" },
  { id: "terminal", label: "Terminal", hint: "Run commands in your environment" },
  { id: "files", label: "Files", hint: "Browse and edit your workspace" },
];

export const WORKBENCH_PLUS_ITEMS: {
  id: string;
  label: string;
  kind: WorkbenchTabKind | "subscriptions" | "side-chat";
  shortcut?: string;
  disabled?: boolean;
}[] = [
  { id: "files", label: "File", kind: "files", shortcut: "Ctrl+O" },
  { id: "terminal", label: "Terminal", kind: "terminal", shortcut: "Ctrl+J" },
  { id: "browser", label: "Browser", kind: "browser", shortcut: "Ctrl+Shift+B" },
  { id: "changes", label: "Changes", kind: "changes", shortcut: "Ctrl+E" },
  { id: "desktop", label: "Desktop", kind: "desktop", shortcut: "Ctrl+D" },
  { id: "environment", label: "Environment", kind: "environment", shortcut: "Ctrl+S" },
  { id: "review", label: "Review", kind: "review" },
  { id: "subscriptions", label: "Subscriptions", kind: "subscriptions", shortcut: "Ctrl+U", disabled: true },
  { id: "side-chat", label: "New Side Chat", kind: "side-chat", shortcut: "Ctrl+Shift+N", disabled: true },
];

export interface WorkbenchTab {
  id: string;
  kind: WorkbenchTabKind;
  title: string;
  closable: boolean;
  url?: string;
  path?: string;
  artifactId?: string;
}

export const WORKBENCH_TEST_ID = "agent-workbench";
export const WORKBENCH_TABBAR_TEST_ID = "agent-workbench-tabbar";

/** One row. These stay pinned; files, diffs, and browser pages append after them. */
export const WORKBENCH_CORE_TABS: WorkbenchTab[] = [
  { id: "preview", kind: "preview", title: "Preview", closable: false },
  { id: "files", kind: "files", title: "Files", closable: false },
  { id: "changes", kind: "changes", title: "Changes", closable: false },
  { id: "terminal", kind: "terminal", title: "Terminal", closable: false },
  { id: "environment", kind: "environment", title: "Environment", closable: false },
];

export function previewTabId(url: string): string {
  return `preview:${url}`;
}

export function fileTabId(path: string): string {
  return `file:${path}`;
}

export function diffTabId(path: string): string {
  return `diff:${path}`;
}

export function artifactTabId(name: string, artifactId?: string): string {
  if (artifactId) return `artifact:${artifactId}:${name}`;
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
    const rest = id.slice("artifact:".length);
    const split = rest.indexOf(":");
    if (split > 0 && !rest.slice(0, split).includes("/") && !rest.slice(0, split).includes("\\")) {
      const artifactId = rest.slice(0, split);
      const path = rest.slice(split + 1);
      return { id, kind: "artifact", title: fileTitle(path), closable: true, path, artifactId };
    }
    return { id, kind: "artifact", title: fileTitle(rest), closable: true, path: rest };
  }
  if (id.startsWith("browser:")) {
    return { id, kind: "browser", title: "Browser", closable: true };
  }
  if (id.startsWith("terminal:")) {
    const n = id.slice("terminal:".length);
    return { id, kind: "terminal", title: `Terminal ${n}`, closable: true };
  }
  const pinned: Record<string, WorkbenchTab> = {
    preview: { id: "preview", kind: "preview", title: "Preview", closable: false },
    changes: { id: "changes", kind: "changes", title: "Changes", closable: false },
    desktop: { id: "desktop", kind: "desktop", title: "Desktop", closable: true },
    browser: { id: "browser", kind: "browser", title: "Browser", closable: true },
    files: { id: "files", kind: "files", title: "Files", closable: false },
    terminal: { id: "terminal", kind: "terminal", title: "Terminal", closable: false },
    review: { id: "review", kind: "review", title: "Review", closable: true },
    environment: { id: "environment", kind: "environment", title: "Environment", closable: false },
    plan: { id: "plan", kind: "plan", title: "Plan", closable: true },
    docs: { id: "docs", kind: "docs", title: "Docs", closable: true },
  };
  if (!id) return { id: "", kind: "changes", title: "Workbench", closable: false };
  return pinned[id] ?? { id: "changes", kind: "changes", title: "Changes", closable: true };
}

export function upsertTab(tabs: WorkbenchTab[], tab: WorkbenchTab): WorkbenchTab[] {
  if (tabs.some((t) => t.id === tab.id)) return tabs;
  return [...tabs, tab];
}

export interface WorkbenchBrowserSeed {
  id: string;
  kind: string;
  title?: string;
  url?: string;
}

/**
 * Tabs that belong on the single Workbench row.
 * Nothing is pinned until it is opened. Browser pages append on that same row.
 */
export function assembleWorkbenchTabs(input: {
  openTabIds: string[];
  activeTabId?: string;
  previewUrl?: string;
  browserTabs?: WorkbenchBrowserSeed[];
}): WorkbenchTab[] {
  const list: WorkbenchTab[] = [];
  const seen = new Set<string>();
  const pushId = (id: string) => {
    if (!id || seen.has(id)) return;
    const tab = parseWorkbenchTab(id);
    if (!tab.id) return;
    seen.add(tab.id);
    list.push(tab);
  };
  for (const id of input.openTabIds) pushId(id);
  if (input.activeTabId) pushId(input.activeTabId);
  for (const page of input.browserTabs ?? []) {
    if (page.kind !== "browser" || !page.id) continue;
    const id = page.id.startsWith("browser:") ? page.id : `browser:${page.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const title = page.url ? truncateTabTitle(page.title || page.url) : page.title || "Browser";
    list.push({ id, kind: "browser", title, closable: true, url: page.url });
  }
  const previewUrl = input.previewUrl?.trim();
  return list.map((tab) => {
    if (tab.id === "preview" && previewUrl) return { ...tab, url: previewUrl };
    if (tab.kind !== "browser" || !tab.id.startsWith("browser:")) return tab;
    const nativeId = tab.id.slice("browser:".length);
    const page = input.browserTabs?.find((b) => b.id === nativeId || b.id === tab.id);
    if (!page) return tab;
    const title = page.url ? truncateTabTitle(page.title || page.url) : page.title || tab.title;
    return { ...tab, title, url: page.url || tab.url };
  });
}

export function resolveActiveWorkbenchTabId(tabs: WorkbenchTab[], activeTabId: string): string {
  if (activeTabId && tabs.some((t) => t.id === activeTabId)) return activeTabId;
  if (activeTabId.startsWith("preview:") && tabs.some((t) => t.id === "preview")) return "preview";
  return tabs[0]?.id ?? "";
}

export function closeTab(tabs: WorkbenchTab[], id: string, activeId: string): { tabs: WorkbenchTab[]; activeId: string } {
  const next = tabs.filter((t) => t.id !== id || !t.closable);
  if (next.length === tabs.length) return { tabs, activeId };
  if (activeId !== id) return { tabs: next, activeId };
  const idx = tabs.findIndex((t) => t.id === id);
  const fallback = next[Math.max(0, idx - 1)] ?? next[0];
  return { tabs: next, activeId: fallback?.id ?? "" };
}

export function nextTerminalTabId(tabs: WorkbenchTab[]): string {
  const n = tabs.filter((t) => t.kind === "terminal").length;
  return n === 0 ? "terminal" : `terminal:${n + 1}`;
}

export function rememberUrl(recents: string[], url: string, limit = 8): string[] {
  if (!url || !/^https?:\/\//i.test(url)) return recents;
  const next = [url, ...recents.filter((u) => u !== url)];
  return next.slice(0, limit);
}

export function followWorkbenchTab(kind: WorkbenchTabKind, extras?: { url?: string; path?: string; name?: string; browserId?: string; artifactId?: string }): WorkbenchTab {
  if (kind === "preview") {
    const tab = parseWorkbenchTab("preview");
    return extras?.url ? { ...tab, url: extras.url } : tab;
  }
  if (kind === "browser" && extras?.browserId) return parseWorkbenchTab(`browser:${extras.browserId}`);
  if (kind === "diff" && extras?.path) return parseWorkbenchTab(diffTabId(extras.path));
  if (kind === "file" && extras?.path) return parseWorkbenchTab(fileTabId(extras.path));
  if (kind === "artifact" && extras?.name) return parseWorkbenchTab(artifactTabId(extras.name, extras.artifactId));
  return parseWorkbenchTab(kind);
}

export function workbenchMarkupContract(html: string): { workbenches: number; inspectors: number; tabbars: number } {
  return {
    workbenches: (html.match(/data-testid="agent-workbench"/g) ?? []).length,
    inspectors: (html.match(/data-testid="inspector-panel"/g) ?? []).length,
    tabbars: (html.match(/data-testid="agent-workbench-tabbar"/g) ?? []).length,
  };
}
