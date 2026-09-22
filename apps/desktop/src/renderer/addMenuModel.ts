// apps/desktop/src/renderer/addMenuModel.ts
//
// Pure Add menu catalog. Items come from live registries passed in — nothing
// is hardcoded as installed unless the snapshot says it is present.

export type AddSection = "recent" | "add" | "context" | "skills" | "plugins" | "tools";

export type AddItemKind =
  | "attachments"
  | "file"
  | "folder"
  | "workspace"
  | "selection"
  | "tab"
  | "recent-file"
  | "skill"
  | "plugin"
  | "mcp"
  | "browser"
  | "terminal"
  | "server"
  | "git"
  | "navigate";

export interface AddMenuItem {
  id: string;
  section: AddSection;
  kind: AddItemKind;
  name: string;
  description: string;
  selected?: boolean;
  disabled?: boolean;
  empty?: boolean;
  meta?: string;
  path?: string;
  view?: string;
}

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
}

export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  connected?: boolean;
}

export interface McpInfo {
  id: string;
  name: string;
  state: string;
  toolCount?: number;
}

export interface AddMenuSnapshot {
  workspaceRoot: string | null;
  workspaceName: string | null;
  workspaceKind: "folder" | "default" | null;
  localMode: boolean;
  cloudMode: boolean;
  openTabs: string[];
  recents: string[];
  selection: { path: string; startLine: number; endLine: number } | null;
  skills: SkillInfo[];
  plugins: PluginInfo[];
  mcp: McpInfo[];
  sshHostCount: number;
  githubConnected: boolean;
  browserAvailable: boolean;
  selectedIds: string[];
}

const RECENT_KEY = "orvyn:add-menu-recent";

export function loadRecentRefs(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(RECENT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string").slice(0, 6) : [];
  } catch {
    return [];
  }
}

export function rememberRecentRef(id: string): string[] {
  const next = [id, ...loadRecentRefs().filter((x) => x !== id)].slice(0, 6);
  try {
    globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

export function fileName(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}

export function isSelected(selectedIds: string[], id: string): boolean {
  return selectedIds.includes(id);
}

export function toggleSelected(selectedIds: string[], id: string): string[] {
  return selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id];
}

export function moveHighlight(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (index + delta + count) % count;
}

export function buildAddMenuItems(snap: AddMenuSnapshot): AddMenuItem[] {
  const items: AddMenuItem[] = [];
  const selected = new Set(snap.selectedIds);
  const mark = (id: string) => selected.has(id);

  items.push({
    id: "add:attachments",
    section: "add",
    kind: "attachments",
    name: "Attachments",
    description: "Attach files and images",
  });

  const hasWorkspace = Boolean(snap.workspaceRoot && snap.workspaceKind === "folder");

  if (hasWorkspace) {
    items.push({
      id: "ctx:file",
      section: "context",
      kind: "file",
      name: "Add file",
      description: "Add a workspace file as context",
    });
    items.push({
      id: "ctx:folder",
      section: "context",
      kind: "folder",
      name: "Add folder",
      description: "Add a folder inside the open workspace",
    });
    items.push({
      id: "ctx:workspace",
      section: "context",
      kind: "workspace",
      name: "Current workspace",
      description: snap.workspaceName ?? "Open workspace",
      selected: mark("ctx:workspace"),
    });
  } else {
    items.push({
      id: "ctx:none",
      section: "context",
      kind: "workspace",
      name: "Open a workspace to add files",
      description: "File context needs an authorized project folder",
      empty: true,
      disabled: true,
    });
  }

  if (snap.selection) {
    items.push({
      id: `ctx:sel:${snap.selection.path}:${snap.selection.startLine}-${snap.selection.endLine}`,
      section: "context",
      kind: "selection",
      name: "Selected code",
      description: `${fileName(snap.selection.path)} · lines ${snap.selection.startLine}–${snap.selection.endLine}`,
      path: snap.selection.path,
      selected: mark(`ctx:sel:${snap.selection.path}:${snap.selection.startLine}-${snap.selection.endLine}`),
    });
  }

  for (const tab of snap.openTabs.slice(0, 8)) {
    const id = `ctx:tab:${tab}`;
    items.push({
      id,
      section: "context",
      kind: "tab",
      name: fileName(tab),
      description: "Open tab",
      path: tab,
      selected: mark(id),
    });
  }

  if (snap.skills.length === 0) {
    items.push({
      id: "skill:empty",
      section: "skills",
      kind: "skill",
      name: "No skills available",
      description: "ORVYN will list skills from the live registry when any are installed",
      empty: true,
      disabled: true,
    });
  } else {
    for (const s of snap.skills) {
      const id = `skill:${s.id}`;
      items.push({
        id,
        section: "skills",
        kind: "skill",
        name: s.name,
        description: s.description,
        selected: mark(id),
      });
    }
  }

  if (snap.plugins.length === 0 && snap.mcp.length === 0) {
    items.push({
      id: "plugin:empty",
      section: "plugins",
      kind: "plugin",
      name: "No plugins installed",
      description: "Connected MCP servers and integrations appear here",
      empty: true,
      disabled: true,
    });
  } else {
    for (const p of snap.plugins) {
      const id = `plugin:${p.id}`;
      items.push({
        id,
        section: "plugins",
        kind: "plugin",
        name: p.name,
        description: p.description,
        meta: p.connected ? "connected" : undefined,
        selected: mark(id),
      });
    }
  }

  if (snap.mcp.length === 0) {
    items.push({
      id: "mcp:empty",
      section: "plugins",
      kind: "mcp",
      name: "No MCP servers",
      description: "Add servers in Tools & MCP",
      empty: true,
      disabled: true,
      view: "tools",
    });
  } else {
    for (const m of snap.mcp) {
      const id = `mcp:${m.id}`;
      items.push({
        id,
        section: "plugins",
        kind: "mcp",
        name: m.name,
        description: `${m.state.toLowerCase()}${m.toolCount ? ` · ${m.toolCount} tools` : ""}`,
        meta: m.state,
        selected: mark(id),
      });
    }
  }

  if (snap.browserAvailable || snap.localMode) {
    items.push({
      id: "cap:browser",
      section: "tools",
      kind: "browser",
      name: "Browser",
      description: "Open and inspect web pages (ToolGateway still applies)",
      selected: mark("cap:browser"),
    });
  }

  if (snap.localMode) {
    items.push({
      id: "cap:terminal",
      section: "tools",
      kind: "terminal",
      name: "Terminal",
      description: "Open the bottom terminal drawer or add local shell context",
      selected: mark("cap:terminal"),
    });
  }

  if (snap.sshHostCount > 0) {
    items.push({
      id: "cap:server",
      section: "tools",
      kind: "server",
      name: "Server",
      description: `${snap.sshHostCount} SSH host${snap.sshHostCount === 1 ? "" : "s"} configured`,
      selected: mark("cap:server"),
    });
  }

  if (snap.githubConnected) {
    items.push({
      id: "cap:git",
      section: "tools",
      kind: "git",
      name: "GitHub",
      description: "Repository and pull-request tools",
      selected: mark("cap:git"),
    });
  }

  items.push({
    id: "nav:skills",
    section: "tools",
    kind: "navigate",
    name: "Manage skills",
    description: "Open Tools & MCP",
    view: "tools",
  });
  items.push({
    id: "nav:plugins",
    section: "tools",
    kind: "navigate",
    name: "Manage plugins",
    description: "Open Tools & MCP",
    view: "tools",
  });
  items.push({
    id: "nav:mcp",
    section: "tools",
    kind: "navigate",
    name: "MCP settings",
    description: "Open Tools & MCP",
    view: "tools",
  });

  const byId = new Map(items.map((i) => [i.id, i]));
  const recentIds = [...loadRecentRefs(), ...snap.recents.map((p) => `ctx:tab:${p}`)];
  const seen = new Set<string>();
  for (const id of recentIds) {
    if (seen.has(id)) continue;
    const hit = byId.get(id);
    if (!hit || hit.disabled || hit.empty) continue;
    seen.add(id);
    items.unshift({ ...hit, id: `recent:${hit.id}`, section: "recent" });
    if (seen.size >= 4) break;
  }

  return items;
}

export function filterAddMenuItems(items: AddMenuItem[], query: string): AddMenuItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => {
    if (item.empty) return false;
    return (
      item.name.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q) ||
      item.kind.includes(q) ||
      (item.path ?? "").toLowerCase().includes(q)
    );
  });
}

export function itemsForSection(items: AddMenuItem[], section: AddSection): AddMenuItem[] {
  return items.filter((i) => i.section === section);
}

export function composerTriggerKey(key: string): "context" | "capabilities" | "skills" | null {
  if (key === "@") return "context";
  if (key === "/") return "capabilities";
  if (key === "$") return "skills";
  return null;
}

export function capabilityNote(selected: AddMenuItem[]): string {
  const labels = selected
    .filter((i) => !i.id.startsWith("nav:") && !i.empty)
    .map((i) => i.name);
  if (labels.length === 0) return "";
  return `Added context · ${labels.slice(0, 6).join(" + ")}`;
}
