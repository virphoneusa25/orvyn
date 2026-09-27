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
  /** Untruncated label for the tooltip. `title` is what the tab shows. */
  fullTitle?: string;
  url?: string;
  path?: string;
  artifactId?: string;
  /** Native browser tab this workbench tab is showing, when one exists. */
  nativeId?: string;
}

export const WORKBENCH_TEST_ID = "agent-workbench";
export const WORKBENCH_TABBAR_TEST_ID = "agent-workbench-tabbar";

/** One row. These stay pinned; files, diffs, and browser pages append after them. */
export const WORKBENCH_CORE_TABS: WorkbenchTab[] = [
  { id: "preview", kind: "preview", title: "Preview", closable: false },
  { id: "files", kind: "files", title: "Files", closable: false },
  { id: "changes", kind: "changes", title: "Changes", closable: false },
  { id: "terminal", kind: "terminal", title: "Terminal", closable: true },
  { id: "environment", kind: "environment", title: "Environment", closable: false },
];

/** Stable page identity. Trailing slashes and host case do not create a second tab. */
export function normalizeWorkbenchUrl(url: string): string {
  const raw = url.trim();
  try {
    const u = new URL(raw);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) u.port = "";
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.host}${path}${u.search}`;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

export function urlsMatch(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return normalizeWorkbenchUrl(a) === normalizeWorkbenchUrl(b);
}

/** Stable file identity. `./index.html` and `index.html` are one tab. */
export function normalizeWorkbenchPath(path: string): string {
  const slash = path.replace(/\\/g, "/").trim().replace(/^\.\//, "");
  return slash.replace(/\/{2,}/g, "/").replace(/\/$/, "") || slash;
}

export function previewTabId(url: string): string {
  return `preview:${normalizeWorkbenchUrl(url)}`;
}

export function fileTabId(path: string): string {
  return `file:${normalizeWorkbenchPath(path)}`;
}

export function diffTabId(path: string): string {
  return `diff:${normalizeWorkbenchPath(path)}`;
}

export function artifactTabId(name: string, artifactId?: string): string {
  if (artifactId) return `artifact:${artifactId}:${name}`;
  return `artifact:${name}`;
}

export function truncateTabTitle(title: string, max = 28): string {
  const t = title.trim();
  if (t.length <= max) return t;
  const base = t.replace(/\\/g, "/").split("/").pop() || t;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 && base.length - dot <= 8 && !base.slice(dot).includes(" ") ? base.slice(dot) : "";
  if (ext && t.length > max) {
    const keep = Math.max(1, max - 1 - ext.length);
    const head = base.length > max ? base.slice(0, keep) : t.slice(0, keep);
    return `${head}…${ext}`;
  }
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
    const url = normalizeWorkbenchUrl(id.slice("preview:".length));
    const stable = previewTabId(url);
    return { id: stable, kind: "preview", title: previewTitle(url), fullTitle: url, closable: true, url };
  }
  if (id.startsWith("file:")) {
    const path = normalizeWorkbenchPath(id.slice("file:".length));
    const name = fileTitle(path);
    return { id: fileTabId(path), kind: "file", title: truncateTabTitle(name), fullTitle: path, closable: true, path };
  }
  if (id.startsWith("diff:")) {
    const path = normalizeWorkbenchPath(id.slice("diff:".length));
    const name = `${fileTitle(path)} — Diff`;
    return { id: diffTabId(path), kind: "diff", title: truncateTabTitle(name), fullTitle: name, closable: true, path };
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
    return { id, kind: "browser", title: "Browser", closable: true, nativeId: id.slice("browser:".length) };
  }
  if (id.startsWith("terminal:")) {
    const n = id.slice("terminal:".length);
    return { id, kind: "terminal", title: `Terminal ${n}`, closable: true };
  }
  const pinned: Record<string, WorkbenchTab> = {
    preview: { id: "preview", kind: "preview", title: "Preview", closable: true },
    changes: { id: "changes", kind: "changes", title: "Changes", closable: false },
    desktop: { id: "desktop", kind: "desktop", title: "Desktop", closable: true },
    browser: { id: "browser", kind: "browser", title: "Browser", closable: true },
    files: { id: "files", kind: "files", title: "Files", closable: false },
    terminal: { id: "terminal", kind: "terminal", title: "Terminal", closable: true },
    review: { id: "review", kind: "review", title: "Review", closable: true },
    environment: { id: "environment", kind: "environment", title: "Environment", closable: false },
    plan: { id: "plan", kind: "plan", title: "Plan", closable: true },
    docs: { id: "docs", kind: "docs", title: "Docs", closable: true },
  };
  if (!id) return { id: "", kind: "changes", title: "Workbench", closable: false };
  return pinned[id] ?? { id: "changes", kind: "changes", title: "Changes", closable: true };
}

export function upsertTab(tabs: WorkbenchTab[], tab: WorkbenchTab): WorkbenchTab[] {
  return reconcileWorkbenchTabs({
    openTabIds: tabs.map((t) => t.id),
    activeTabId: tab.id,
    previewUrl: tab.url,
    browserTabs: browserSeedsFrom(tabs, tab),
  }).tabs;
}

export interface WorkbenchBrowserSeed {
  id: string;
  kind: string;
  title?: string;
  url?: string;
}

/** Pinned tools stay in this order. Dynamic tabs follow in groups. */
const PINNED_RANK: Record<string, number> = {
  changes: 0,
  files: 1,
  terminal: 2,
  browser: 3,
  desktop: 4,
  environment: 5,
};

export function workbenchTabRank(id: string): number {
  if (id === "terminal" || id.startsWith("terminal:")) return 2;
  if (id === "browser" || id.startsWith("browser:")) return 3;
  if (id in PINNED_RANK) return PINNED_RANK[id]!;
  if (id === "review" || id === "plan" || id === "docs") return 6;
  if (id.startsWith("file:")) return 7;
  if (id.startsWith("diff:")) return 8;
  if (id === "preview" || id.startsWith("preview:")) return 9;
  if (id.startsWith("artifact:")) return 10;
  return 11;
}

export function orderWorkbenchTabs<T extends { id: string }>(tabs: T[]): T[] {
  return tabs
    .map((tab, index) => ({ tab, index }))
    .sort((a, b) => {
      const delta = workbenchTabRank(a.tab.id) - workbenchTabRank(b.tab.id);
      return delta !== 0 ? delta : a.index - b.index;
    })
    .map((row) => row.tab);
}

/**
 * Closing a Workbench tab hides that view.
 * It never stops a website server or kills a terminal. The native browser
 * view closes only for a Browser page that is not the running preview.
 */
export function workbenchTabCloseEffect(tab: WorkbenchTab): { stopServer: false; killTerminal: false; closeNativeView: boolean } {
  const previewPage = tab.kind === "preview" || (tab.kind === "browser" && !!tab.url && tab.id.startsWith("preview:"));
  return {
    stopServer: false,
    killTerminal: false,
    closeNativeView: tab.kind === "browser" && !previewPage,
  };
}

function browserSeedsFrom(tabs: WorkbenchTab[], extra?: WorkbenchTab): WorkbenchBrowserSeed[] {
  const seeds: WorkbenchBrowserSeed[] = [];
  for (const tab of extra ? [...tabs, extra] : tabs) {
    if (tab.kind !== "browser") continue;
    const id = tab.nativeId || (tab.id.startsWith("browser:") ? tab.id.slice("browser:".length) : "");
    if (!id) continue;
    seeds.push({ id, kind: "browser", title: tab.fullTitle || tab.title, url: tab.url });
  }
  return seeds;
}

function previewTabFor(url: string, nativeId?: string, pageTitle?: string): WorkbenchTab {
  const normal = normalizeWorkbenchUrl(url);
  const tab = parseWorkbenchTab(previewTabId(normal));
  const named = pageTitle && !/^https?:\/\//i.test(pageTitle) ? pageTitle : "";
  return { ...tab, url: normal, nativeId, fullTitle: named || normal, title: named ? truncateTabTitle(named) : tab.title };
}

function browserTabFor(native: WorkbenchBrowserSeed): WorkbenchTab {
  const id = native.id.startsWith("browser:") ? native.id : `browser:${native.id}`;
  const full = (native.title || native.url || "Browser").trim() || "Browser";
  return {
    id,
    kind: "browser",
    title: truncateTabTitle(full),
    fullTitle: full,
    closable: true,
    url: native.url ? normalizeWorkbenchUrl(native.url) : undefined,
    nativeId: native.id.startsWith("browser:") ? native.id.slice("browser:".length) : native.id,
  };
}

export interface ReconciledWorkbenchTabs {
  tabs: WorkbenchTab[];
  activeId: string;
  openTabIds: string[];
}

/**
 * One row, stable ids.
 * `browser` and `browser:<native-id>` collapse to the native tab.
 * A preview URL and a Browser native tab for that same URL collapse to one preview tab.
 */
export function reconcileWorkbenchTabs(input: {
  openTabIds: string[];
  activeTabId?: string;
  previewUrl?: string;
  browserTabs?: WorkbenchBrowserSeed[];
}): ReconciledWorkbenchTabs {
  const natives = input.browserTabs ?? [];
  const previewUrls = new Set<string>();
  const notePreview = (url?: string) => {
    if (!url) return;
    const normal = normalizeWorkbenchUrl(url);
    if (normal) previewUrls.add(normal);
  };
  notePreview(input.previewUrl);
  for (const id of input.openTabIds) {
    if (id.startsWith("preview:")) notePreview(id.slice("preview:".length));
  }
  if (input.activeTabId?.startsWith("preview:")) notePreview(input.activeTabId.slice("preview:".length));
  for (const page of natives) {
    if (page.kind === "preview") notePreview(page.url);
  }

  const byKey = new Map<string, { tab: WorkbenchTab; index: number }>();
  let index = 0;
  const consider = (tab: WorkbenchTab) => {
    if (!tab.id) return;
    let next = tab;
    if (next.kind === "browser" && next.url && previewUrls.has(normalizeWorkbenchUrl(next.url))) {
      next = previewTabFor(next.url, next.nativeId, next.fullTitle || next.title);
    }
    const key = next.kind === "preview" && next.url
      ? previewTabId(next.url)
      : next.kind === "file" && next.path
        ? fileTabId(next.path)
        : next.kind === "diff" && next.path
          ? diffTabId(next.path)
          : next.kind === "artifact" && next.artifactId
            ? `artifact:${next.artifactId}`
            : next.id;
    if (key !== next.id && (key.startsWith("preview:") || key.startsWith("file:") || key.startsWith("diff:"))) {
      next = { ...next, id: key };
    }
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { tab: next, index: index++ });
      return;
    }
    byKey.set(key, {
      index: prev.index,
      tab: {
        ...prev.tab,
        ...next,
        id: key,
        title: next.title || prev.tab.title,
        fullTitle: next.fullTitle || prev.tab.fullTitle,
        url: next.url || prev.tab.url,
        nativeId: next.nativeId || prev.tab.nativeId,
        path: next.path || prev.tab.path,
      },
    });
  };

  const ids = [...input.openTabIds];
  if (input.activeTabId && !ids.includes(input.activeTabId)) ids.push(input.activeTabId);
  for (const id of ids) {
    if (!id) continue;
    let tab = parseWorkbenchTab(id);
    if (tab.kind === "browser" && tab.nativeId) {
      const native = natives.find((page) => page.id === tab.nativeId || page.id === tab.id);
      if (native?.url && previewUrls.has(normalizeWorkbenchUrl(native.url))) {
        tab = previewTabFor(native.url, tab.nativeId, native.title);
      } else if (native) {
        tab = browserTabFor({ ...native, id: tab.nativeId });
      }
    } else if ((tab.id === "preview" || tab.kind === "preview") && !tab.url && input.previewUrl) {
      tab = previewTabFor(input.previewUrl);
    }
    consider(tab);
  }

  const placeholder = byKey.get("browser");
  if (placeholder) {
    const native = natives.find((page) => page.kind !== "preview" && page.id && !(page.url && previewUrls.has(normalizeWorkbenchUrl(page.url))));
    const previewNative = natives.find((page) => page.url && previewUrls.has(normalizeWorkbenchUrl(page.url)));
    byKey.delete("browser");
    if (native && !byKey.has(`browser:${native.id}`)) consider(browserTabFor(native));
    else if (!native && previewNative?.url) consider(previewTabFor(previewNative.url, previewNative.id, previewNative.title));
    else if (!native && !previewNative) byKey.set("browser", placeholder);
  }

  const hasNativeBrowser = [...byKey.values()].some((row) => row.tab.kind === "browser" && row.tab.id.startsWith("browser:"));
  if (hasNativeBrowser) byKey.delete("browser");

  const tabs = orderWorkbenchTabs([...byKey.values()].sort((a, b) => a.index - b.index).map((row) => row.tab));
  const activeId = resolveActiveWorkbenchTabId(tabs, input.activeTabId || "");
  return { tabs, activeId, openTabIds: tabs.map((tab) => tab.id) };
}

export function assembleWorkbenchTabs(input: {
  openTabIds: string[];
  activeTabId?: string;
  previewUrl?: string;
  browserTabs?: WorkbenchBrowserSeed[];
}): WorkbenchTab[] {
  return reconcileWorkbenchTabs(input).tabs;
}

export function canonicalizeOpenTabIds(ids: string[]): string[] {
  return reconcileWorkbenchTabs({ openTabIds: ids }).openTabIds;
}

export function aliasActiveTabId(activeTabId: string, openTabIds: string[]): string {
  if (!activeTabId) return "";
  const tabs = reconcileWorkbenchTabs({ openTabIds }).tabs;
  if (tabs.some((tab) => tab.id === activeTabId)) return activeTabId;
  const canon = activeTabId.startsWith("file:")
    ? fileTabId(activeTabId.slice("file:".length))
    : activeTabId.startsWith("diff:")
      ? diffTabId(activeTabId.slice("diff:".length))
      : activeTabId.startsWith("preview:")
        ? previewTabId(activeTabId.slice("preview:".length))
        : activeTabId;
  if (tabs.some((tab) => tab.id === canon)) return canon;
  if (activeTabId === "browser") {
    const native = tabs.filter((tab) => tab.kind === "browser");
    if (native.length === 1) return native[0]!.id;
  }
  if (activeTabId === "preview" || activeTabId.startsWith("preview:")) {
    const preview = tabs.find((tab) => tab.kind === "preview");
    if (preview) return preview.id;
  }
  return activeTabId;
}

export function resolveActiveWorkbenchTabId(tabs: WorkbenchTab[], activeTabId: string): string {
  if (!activeTabId) return tabs[0]?.id ?? "";
  if (tabs.some((tab) => tab.id === activeTabId)) return activeTabId;
  const canon = activeTabId.startsWith("file:")
    ? fileTabId(activeTabId.slice("file:".length))
    : activeTabId.startsWith("diff:")
      ? diffTabId(activeTabId.slice("diff:".length))
      : activeTabId.startsWith("preview:")
        ? previewTabId(activeTabId.slice("preview:".length))
        : activeTabId;
  const exact = tabs.find((tab) => tab.id === canon);
  if (exact) return exact.id;
  if (activeTabId === "browser" || activeTabId.startsWith("browser:")) {
    const nativeId = activeTabId.startsWith("browser:") ? activeTabId.slice("browser:".length) : "";
    const byNative = tabs.find((tab) => tab.nativeId === nativeId && nativeId);
    if (byNative) return byNative.id;
    const browser = tabs.find((tab) => tab.kind === "browser");
    if (browser && activeTabId === "browser") return browser.id;
    const preview = nativeId ? tabs.find((tab) => tab.kind === "preview" && tab.nativeId === nativeId) : undefined;
    if (preview) return preview.id;
  }
  if (activeTabId === "preview" || activeTabId.startsWith("preview:")) {
    const preview = tabs.find((tab) => tab.kind === "preview");
    if (preview) return preview.id;
  }
  return tabs[0]?.id ?? "";
}

export function closeTab(tabs: WorkbenchTab[], id: string, activeId: string): { tabs: WorkbenchTab[]; activeId: string } {
  const ordered = orderWorkbenchTabs(tabs);
  const target = ordered.find((tab) => tab.id === id) ?? ordered.find((tab) => tab.nativeId && id.endsWith(tab.nativeId));
  const closing = target?.id ?? id;
  const next = ordered.filter((tab) => tab.id !== closing || !tab.closable);
  if (next.length === ordered.length) return { tabs: ordered, activeId: resolveActiveWorkbenchTabId(ordered, activeId) };
  if (activeId !== closing && activeId !== id) return { tabs: next, activeId: resolveActiveWorkbenchTabId(next, activeId) };
  const idx = ordered.findIndex((tab) => tab.id === closing);
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
  if (kind === "preview" && extras?.url) return previewTabFor(extras.url);
  if (kind === "preview") return parseWorkbenchTab("preview");
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
