// apps/desktop/src/renderer/agentWorkspaceModel.ts
//
// Derives the Agent Workspace from existing run events. No second event store.

export const AGENT_WORKSPACE_TABS = [
  "preview",
  "changes",
  "files",
  "diff",
  "terminal",
  "browser",
  "review",
  "plan",
  "docs",
  "desktop",
  "environment",
] as const;

export type AgentWorkspaceTab = (typeof AGENT_WORKSPACE_TABS)[number];

export const PRIMARY_WORKSPACE_TABS: { id: AgentWorkspaceTab; label: string }[] = [
  { id: "preview", label: "Preview" },
  { id: "changes", label: "Changes" },
  { id: "files", label: "Files" },
  { id: "diff", label: "Diff" },
  { id: "terminal", label: "Terminal" },
  { id: "browser", label: "Browser" },
  { id: "review", label: "Review" },
];

export const OVERFLOW_WORKSPACE_TABS: { id: AgentWorkspaceTab; label: string }[] = [
  { id: "plan", label: "Plan" },
  { id: "docs", label: "Docs" },
  { id: "desktop", label: "Desktop" },
];

export function isAgentWorkspaceTab(value: unknown): value is AgentWorkspaceTab {
  return typeof value === "string" && (AGENT_WORKSPACE_TABS as readonly string[]).includes(value);
}

export type FileKind = "created" | "modified" | "deleted" | "read" | "artifact";

export interface WorkspaceFile {
  path: string;
  kind: FileKind;
  additions?: number;
  deletions?: number;
  status?: string;
  artifactId?: string;
  mimeType?: string;
}

export interface WorkspaceDiff {
  path: string;
  kind?: string;
  additions: number;
  deletions: number;
  diff?: { type: string; content: string }[];
}

export interface PreviewTarget {
  url: string;
  label: string;
  port?: number;
  source: "dev-server" | "preview.available" | "browser";
  local: boolean;
}

export interface BrowserAction {
  id: string;
  tool: string;
  label: string;
  url?: string;
  x?: number;
  y?: number;
  kind: "click" | "type" | "scroll" | "hover" | "navigate" | "other";
  live: boolean;
  snapshot?: string;
}

export interface WorkspaceActivity {
  line: string;
  priority: number;
  tab: AgentWorkspaceTab;
  previewUrl?: string;
  file?: string;
  artifactId?: string;
  /** When false, Follow ORION updates the activity line only — the active tab stays put. */
  switchTab?: boolean;
}

export interface AgentWorkspaceDerived {
  files: WorkspaceFile[];
  artifacts: WorkspaceFile[];
  diffs: WorkspaceDiff[];
  previews: PreviewTarget[];
  browser: {
    url?: string;
    actions: BrowserAction[];
    cursor: { x: number; y: number; kind: BrowserAction["kind"] } | null;
    console: string[];
    network: { method: string; url: string; status?: string }[];
  };
  activity: WorkspaceActivity | null;
  suggestedTab: AgentWorkspaceTab;
  waitingApproval: boolean;
  changeSummary: { files: number; additions: number; deletions: number };
}

export interface WorkspaceEvent {
  id?: string;
  type: string;
  timestamp?: number;
  data?: Record<string, unknown>;
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i;
const PREVIEW_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::(\d{2,5}))?(?:\/[^\s"'<>]*)?/gi;
const DEV_HINT = /\b(vite|next\.js|nextjs|webpack|astro|nuxt|remix|angular|vue|react|ready in \d|local:\s*http)/i;

export function isSafeHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function isLocalPreviewUrl(url: string): boolean {
  try {
    return LOCAL_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function detectPreviewUrls(text: string): PreviewTarget[] {
  if (!text) return [];
  const found: PreviewTarget[] = [];
  const seen = new Set<string>();
  const re = new RegExp(PREVIEW_URL.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[0]!.replace(/[.,);]+$/, "");
    if (!isSafeHttpUrl(raw) || seen.has(raw)) continue;
    seen.add(raw);
    const port = m[1] ? Number(m[1]) : undefined;
    found.push({
      url: raw,
      label: port ? `Preview :${port}` : "Preview",
      port,
      source: DEV_HINT.test(text) ? "dev-server" : "dev-server",
      local: true,
    });
  }
  return found;
}

export function previewLabel(target: PreviewTarget, projectName?: string | null): string {
  const name = (projectName || "ORVYN").slice(0, 18);
  return target.port ? `${name} :${target.port}` : target.label;
}

function filePath(data: Record<string, unknown> | undefined): string {
  const preview = data?.preview as { path?: string } | undefined;
  return String(preview?.path ?? data?.path ?? "").replace(/\\/g, "/");
}

function actionKind(tool: string, type: string): BrowserAction["kind"] {
  const t = `${tool} ${type}`.toLowerCase();
  if (t.includes("click")) return "click";
  if (t.includes("type") || t.includes("fill") || t.includes("press")) return "type";
  if (t.includes("scroll")) return "scroll";
  if (t.includes("hover")) return "hover";
  if (t.includes("goto") || t.includes("navigate") || t.includes("open")) return "navigate";
  return "other";
}

function cursorFrom(data: Record<string, unknown> | undefined): { x: number; y: number } | null {
  if (!data) return null;
  const input = (data.input as Record<string, unknown> | undefined) ?? {};
  const x = Number(data.x ?? data.clientX ?? input.x ?? input.clientX);
  const y = Number(data.y ?? data.clientY ?? input.y ?? input.clientY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

export function activityPriority(kind: AgentWorkspaceTab | "approval" | "read"): number {
  if (kind === "approval") return 100;
  if (kind === "browser" || kind === "preview") return 80;
  if (kind === "review") return 75;
  if (kind === "diff" || kind === "terminal" || kind === "changes") return 70;
  if (kind === "desktop" || kind === "docs" || kind === "plan") return 60;
  return 20;
}

export function routeEvent(e: WorkspaceEvent): WorkspaceActivity | null {
  const type = e.type;
  const data = e.data ?? {};
  const tool = String(data.tool ?? "");
  if (type === "approval.required") {
    return { line: `Waiting for approval · ${tool || "tool"}`, priority: 100, tab: "changes", switchTab: false };
  }
  if (type.startsWith("browser.") || tool.startsWith("browser_")) {
    const url = String(data.url ?? (data.input as { url?: string } | undefined)?.url ?? "");
    const local = url ? isLocalPreviewUrl(url) : false;
    const kind = actionKind(tool, type);
    const label =
      kind === "click" ? `Clicking ${String(data.target ?? data.selector ?? "page")}` :
      kind === "type" ? "Typing" :
      kind === "scroll" ? "Scrolling" :
      url ? `Inspecting ${url}` : "Browsing";
    return {
      line: label,
      priority: 80,
      tab: local ? "preview" : "browser",
      previewUrl: url || undefined,
    };
  }
  if (type.startsWith("desktop.") || tool.startsWith("desktop_")) {
    const url = String(data.url ?? (data.input as { url?: string } | undefined)?.url ?? "");
    const complete = type === "desktop.completed" || type === "desktop.failed" || tool === "desktop_stop";
    const line =
      type === "desktop.failed" ? "Desktop failed" :
      tool === "desktop_click" ? `Desktop click ${String(data.target ?? data.selector ?? "")}`.trim() :
      tool === "desktop_type" ? "Desktop typing" :
      tool === "desktop_scroll" ? "Desktop scrolling" :
      url ? `Desktop ${url}` : "Desktop session";
    return {
      line,
      priority: 82,
      tab: "desktop",
      previewUrl: url || undefined,
      switchTab: !complete || type === "desktop.failed",
    };
  }
  if (type === "file.edit") {
    const path = filePath(data);
    return { line: path ? `Editing ${path}` : "Editing files", priority: 70, tab: "diff", file: path || undefined };
  }
  if (type === "terminal.started" || type === "terminal.output" || tool === "terminal") {
    const cmd = String(data.command ?? data.preview ?? "command").split("\n")[0]!.slice(0, 80);
    return { line: `Running ${cmd}`, priority: 70, tab: "terminal" };
  }
  if (type === "preview.available") {
    const url = String(data.url ?? "");
    return { line: url ? `Preview ${url}` : "Preview ready", priority: 96, tab: "preview", previewUrl: url || undefined, switchTab: true };
  }
  if (type.startsWith("review.")) {
    const complete = type === "review.passed" || type === "review.approved";
    const rejected = type === "review.rejected" || type === "review.failed";
    return {
      line: complete ? "Review ready" : rejected ? "Review failed" : "Review in progress",
      priority: complete || rejected ? 75 : 40,
      tab: "review",
      switchTab: complete || rejected,
    };
  }
  if (type === "file.read") {
    const path = filePath(data);
    return { line: path ? `Reading ${path}` : "Reading files", priority: 20, tab: "files", file: path || undefined, switchTab: false };
  }
  if (type === "tool.completed" && tool === "create_document") {
    return { line: "Created artifact", priority: 65, tab: "docs" };
  }
  if (type === "files.ready" || (type === "artifact.created" && (data.artifactId || data.id))) {
    const name = String(data.name ?? data.filename ?? data.path ?? "file");
    const artifactId = typeof data.artifactId === "string" ? data.artifactId : typeof data.id === "string" ? data.id : undefined;
    const page = /\.(html?|php)$/i.test(name);
    return { line: `${name} is in Files → Generated`, priority: page ? 40 : 90, tab: "files", file: name, artifactId, switchTab: !page };
  }
  if (type === "tool.completed" && (tool === "generate_image" || data.artifactId)) {
    const name = String(data.artifactName ?? data.name ?? data.filename ?? "");
    const artifactId = typeof data.artifactId === "string" ? data.artifactId : undefined;
    if (name || artifactId) {
      return { line: `${name || "File"} is in Files → Generated`, priority: 90, tab: "files", file: name || undefined, artifactId, switchTab: true };
    }
  }
  return null;
}

export function shouldAutoSwitch(
  previous: WorkspaceActivity | null,
  next: WorkspaceActivity,
  elapsedMs: number,
  debounceMs = 400
): boolean {
  if (!previous) return true;
  if (next.priority >= 100) return true;
  if (next.priority < 30) return false;
  if (next.tab === previous.tab && next.file === previous.file) return false;
  if (elapsedMs < debounceMs && next.priority <= previous.priority) return false;
  return next.priority >= previous.priority || elapsedMs >= debounceMs;
}

export function deriveAgentWorkspace(events: WorkspaceEvent[], opts?: { projectName?: string | null }): AgentWorkspaceDerived {
  const files = new Map<string, WorkspaceFile>();
  const artifacts = new Map<string, WorkspaceFile>();
  const diffs: WorkspaceDiff[] = [];
  const previews = new Map<string, PreviewTarget>();
  const actions: BrowserAction[] = [];
  const consoleLines: string[] = [];
  const network: { method: string; url: string; status?: string }[] = [];
  let cursor: AgentWorkspaceDerived["browser"]["cursor"] = null;
  let browserUrl: string | undefined;
  let waitingApproval = false;
  let latest: WorkspaceActivity | null = null;
  let latestAt = 0;

  const absorbPreview = (text: string, source: PreviewTarget["source"] = "dev-server") => {
    for (const p of detectPreviewUrls(text)) {
      previews.set(p.url, { ...p, source, label: previewLabel(p, opts?.projectName) });
    }
  };

  for (const e of events) {
    const data = e.data ?? {};
    const type = e.type;
    const tool = String(data.tool ?? "");
    const ts = Number(e.timestamp ?? 0);

    if (type === "preview.available" && typeof data.url === "string" && isSafeHttpUrl(data.url)) {
      const local = isLocalPreviewUrl(data.url);
      const port = (() => {
        try { const n = Number(new URL(data.url).port); return n || undefined; } catch { return undefined; }
      })();
      previews.set(data.url, {
        url: data.url,
        label: String(data.label ?? previewLabel({ url: data.url, label: "Preview", port, source: "preview.available", local }, opts?.projectName)),
        port,
        source: "preview.available",
        local,
      });
    }

    if (type === "terminal.output" || type === "tool.completed" || type === "terminal.started") {
      absorbPreview(String(data.chunk ?? data.output ?? data.preview ?? data.command ?? ""));
    }

    if (type === "file.read") {
      const path = filePath(data);
      if (path && !files.has(path)) files.set(path, { path, kind: "read", status: "Read" });
    }
    if (type === "file.edit") {
      const preview = data.preview as WorkspaceDiff | undefined;
      const path = filePath(data);
      if (path) {
        const kind: FileKind = preview?.kind === "create" ? "created" : preview?.kind === "delete" ? "deleted" : "modified";
        files.set(path, {
          path,
          kind,
          additions: preview?.additions,
          deletions: preview?.deletions,
          status: kind === "created" ? "Created" : kind === "deleted" ? "Deleted" : "Modified",
        });
        if (preview?.path || preview?.diff) {
          const existing = diffs.findIndex((d) => d.path === path);
          const next = {
            path,
            kind: preview.kind,
            additions: preview.additions ?? 0,
            deletions: preview.deletions ?? 0,
            diff: preview.diff,
          };
          if (existing >= 0) diffs[existing] = next;
          else diffs.push(next);
        }
      }
    }
    if (type === "tool.completed" && tool === "create_document") {
      const name = String(data.name ?? data.path ?? data.preview ?? "document");
      artifacts.set(name, { path: name, kind: "artifact", status: "Artifact" });
    }
    if (type === "artifact.created" || type === "files.ready" || (type === "tool.completed" && (tool === "generate_image" || data.artifactId))) {
      const name = String(data.name ?? data.filename ?? data.artifactName ?? data.path ?? "");
      if (name) {
        const prev = artifacts.get(name);
        artifacts.set(name, {
          path: name,
          kind: "artifact",
          status: data.kind === "generated" || tool === "generate_image" ? "Generated" : prev?.status ?? "Artifact",
          artifactId: typeof data.artifactId === "string" ? data.artifactId : typeof data.id === "string" ? data.id : prev?.artifactId,
          mimeType: typeof data.mimeType === "string" ? data.mimeType : prev?.mimeType,
        });
      }
    }

    if (type.startsWith("browser.") || tool.startsWith("browser_") || type.startsWith("desktop.") || tool.startsWith("desktop_")) {
      const url = String(data.url ?? (data.input as { url?: string } | undefined)?.url ?? "");
      if (url && isSafeHttpUrl(url)) {
        browserUrl = url;
        if (isLocalPreviewUrl(url)) {
          absorbPreview(url, "browser");
        }
      }
      const xy = cursorFrom(data);
      const kind = actionKind(tool, type);
      if (xy) cursor = { ...xy, kind };
      actions.push({
        id: String(e.id ?? `${type}-${ts}`),
        tool: tool || type,
        label: String(data.preview ?? data.target ?? tool.replace("browser_", "") ?? type),
        url: url || undefined,
        x: xy?.x,
        y: xy?.y,
        kind,
        live: type === "browser.action" || type === "tool.started",
        snapshot: typeof data.screenshot === "string" ? data.screenshot : typeof data.image === "string" ? data.image : undefined,
      });
      if (data.console) consoleLines.push(String(data.console).slice(0, 200));
      if (data.error && String(data.error).includes("http")) consoleLines.push(String(data.error).slice(0, 200));
      const net = data.request as { method?: string; url?: string; status?: string } | undefined;
      if (net?.url) network.push({ method: String(net.method ?? "GET"), url: String(net.url), status: net.status ? String(net.status) : undefined });
    }

    if (type === "approval.required") waitingApproval = true;
    if (type === "approval.resolved") waitingApproval = false;

    let routed = routeEvent(e);
    if ((type === "run.completed" || type === "mission.completed") && artifacts.size > 0) {
      const first = [...artifacts.values()][0];
      routed = {
        line: `${first.path} is in Files → Generated`,
        priority: 90,
        tab: "files",
        file: first.path,
        artifactId: first.artifactId,
        switchTab: true,
      };
    }
    if (routed && shouldAutoSwitch(latest, routed, ts && latestAt ? ts - latestAt : 1000)) {
      latest = routed;
      latestAt = ts || latestAt;
    }
  }

  const finished = events.some((e) => e.type === "run.completed" || e.type === "mission.completed");
  const blocked = events.some((e) => e.type === "run.blocked" || e.type === "resource.required");
  const reviewable = diffs.length > 0 && artifacts.size === 0;
  if (finished && reviewable && !blocked) {
    latest = { line: "Review ready", priority: 75, tab: "review", switchTab: true };
  }

  const fileList = [...files.values()].reverse();
  const diffList = diffs.slice().reverse();
  const previewList = [...previews.values()];
  let additions = 0;
  let deletions = 0;
  for (const d of diffs) {
    additions += d.additions;
    deletions += d.deletions;
  }

  return {
    files: fileList,
    artifacts: [...artifacts.values()],
    diffs: diffList,
    previews: previewList,
    browser: {
      url: browserUrl,
      actions: actions.slice(-40),
      cursor,
      console: consoleLines.slice(-20),
      network: network.slice(-20),
    },
    activity: latest,
    suggestedTab: latest?.tab ?? (previewList.length ? "preview" : diffList.length ? "diff" : "changes"),
    waitingApproval,
    changeSummary: { files: diffs.length || fileList.filter((f) => f.kind !== "read").length, additions, deletions },
  };
}

export function mapContextTab(tab?: string): AgentWorkspaceTab | undefined {
  if (!tab) return undefined;
  if (tab === "documents") return "docs";
  if (tab.startsWith("preview")) return "preview";
  if (isAgentWorkspaceTab(tab)) return tab;
  return undefined;
}

export function previewTabId(url: string): AgentWorkspaceTab {
  return url ? "preview" : "changes";
}

export function parseActiveTab(id: string | undefined): { tab: AgentWorkspaceTab; previewUrl?: string } {
  if (!id) return { tab: "changes" };
  if (id.startsWith("preview:")) return { tab: "preview", previewUrl: id.slice("preview:".length) };
  if (id.startsWith("artifact:")) return { tab: "docs" };
  if (isAgentWorkspaceTab(id)) return { tab: id };
  return { tab: "changes" };
}

export interface FollowController {
  followOrion: boolean;
  paused: boolean;
}

export function initialFollowState(runActive: boolean): FollowController {
  return { followOrion: runActive, paused: false };
}

export function applyManualTab(state: FollowController): FollowController {
  if (!state.followOrion) return state;
  return { ...state, paused: true };
}

export function resumeFollow(): FollowController {
  return { followOrion: true, paused: false };
}

export function toggleFollow(state: FollowController): FollowController {
  if (state.followOrion && !state.paused) return { followOrion: false, paused: false };
  return { followOrion: true, paused: false };
}

export function followApplies(state: FollowController): boolean {
  return state.followOrion && !state.paused;
}

export function followedTab(derived: AgentWorkspaceDerived): AgentWorkspaceTab {
  if (derived.activity && derived.activity.switchTab === false) {
    return derived.suggestedTab === "review" ? "changes" : derived.suggestedTab;
  }
  return derived.activity?.tab ?? derived.suggestedTab;
}

export function followedPreviewUrl(derived: AgentWorkspaceDerived): string | undefined {
  return derived.activity?.previewUrl ?? derived.previews[0]?.url;
}

export interface ReviewSummary {
  filesChanged: number;
  additions: number;
  deletions: number;
  testsPassed: number;
  testsFailed: number;
  buildPassed: boolean | null;
  warnings: number;
  artifacts: number;
  completed: boolean;
}

export function deriveReviewSummary(events: WorkspaceEvent[], derived: AgentWorkspaceDerived): ReviewSummary {
  let testsPassed = 0;
  let testsFailed = 0;
  let warnings = 0;
  let buildPassed: boolean | null = null;
  let completed = false;
  let blockedRun = false;
  for (const e of events) {
    const data = e.data ?? {};
    if (e.type === "test.completed") {
      if (data.ok === true) testsPassed += 1;
      else testsFailed += 1;
    }
    if (e.type === "test.started" && String(data.kind ?? "").toLowerCase().includes("build")) {
      /* counted on completed */
    }
    if (e.type === "tool.completed" && /build|vite|tsc|webpack/i.test(String(data.tool ?? data.command ?? data.preview ?? ""))) {
      buildPassed = true;
    }
    if (e.type === "tool.failed" && /build|vite|tsc|webpack/i.test(String(data.tool ?? data.command ?? ""))) {
      buildPassed = false;
    }
    if (e.type === "review.rejected" || e.type === "tool.failed") warnings += 1;
    if (e.type === "run.blocked" || e.type === "resource.required" || e.type === "run.error") blockedRun = true;
    if (e.type === "run.completed" || e.type === "mission.completed" || e.type === "review.approved" || e.type === "review.passed") {
      completed = true;
    }
  }
  return {
    filesChanged: derived.changeSummary.files,
    additions: derived.changeSummary.additions,
    deletions: derived.changeSummary.deletions,
    testsPassed,
    testsFailed,
    buildPassed,
    warnings,
    artifacts: derived.artifacts.length,
    completed: completed && !blockedRun && (derived.changeSummary.files > 0 || derived.artifacts.length > 0 || testsPassed > 0 || testsFailed > 0),
  };
}

export function reconstructWorkspace(events: WorkspaceEvent[], opts?: { projectName?: string | null }): AgentWorkspaceDerived {
  return deriveAgentWorkspace(events, opts);
}

export function extractOrionCommands(events: WorkspaceEvent[]): { id: string; command: string; output: string; running: boolean }[] {
  const cmds: { id: string; command: string; output: string; running: boolean }[] = [];
  const byId = new Map<string, { id: string; command: string; output: string; running: boolean }>();
  for (const e of events) {
    const data = e.data ?? {};
    const tool = String(data.tool ?? "");
    if (e.type === "terminal.started" || (e.type === "tool.started" && tool === "terminal")) {
      const id = String(e.id ?? data.taskId ?? cmds.length);
      const command = String(data.command ?? data.preview ?? "command").split("\n")[0]!.slice(0, 120);
      const row = { id, command, output: "", running: true };
      byId.set(id, row);
      cmds.push(row);
    }
    if (e.type === "terminal.output") {
      const last = cmds[cmds.length - 1];
      if (last) last.output = (last.output + String(data.chunk ?? data.output ?? "")).slice(-12000);
    }
    if (e.type === "terminal.completed" || (e.type === "tool.completed" && tool === "terminal")) {
      const last = cmds[cmds.length - 1];
      if (last) {
        last.running = false;
        if (data.output || data.preview) last.output = (last.output + String(data.output ?? data.preview ?? "")).slice(-12000);
      }
    }
  }
  return cmds.slice(-8);
}

export function cursorOverlayStyle(
  cursor: { x: number; y: number; kind: BrowserAction["kind"] } | null,
  viewport: { width: number; height: number } = { width: 1280, height: 800 }
): { left: number; top: number; kind: BrowserAction["kind"] } | null {
  if (!cursor) return null;
  const left = Math.max(8, Math.min(viewport.width - 8, cursor.x));
  const top = Math.max(8, Math.min(viewport.height - 8, cursor.y));
  return { left, top, kind: cursor.kind };
}
