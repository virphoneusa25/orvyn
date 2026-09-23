// apps/desktop/src/main/main.ts
import { app, BrowserWindow, clipboard, ipcMain, dialog, safeStorage, shell } from "electron";
import { handleWindowAction, validateClipboardText, validateExternalUrl, validateSaveTextPayload, WINDOW_IPC } from "./windowIpc";
import * as path from "path";
import * as os from "os";
import { promises as fs } from "fs";
import { spawn, ChildProcess } from "child_process";
import { createWriteStream } from "fs";
import { connectionFileRecord } from "./connectionRecord";
import { createWorkbenchBrowserManager, registerBrowserIpc, type WorkbenchBrowserManager } from "./workbenchBrowser";
import { fetchOfficialRegistry } from "./officialRegistryFetch";

let browserManager: WorkbenchBrowserManager | null = null;

let mainWindow: BrowserWindow | null = null;
let currentProjectRoot: string | null = null;
let localEngine: ChildProcess | null = null;
let engineStarting = false;
let quitting = false;
let engineTimer: ReturnType<typeof setInterval> | undefined;

async function ensureLocalEngine(): Promise<void> {
  if (quitting || engineStarting || localEngine) return;
  const config = await readConfig();
  if (!/^http:\/\/(localhost|127\.0\.0\.1):4570\/?$/.test(config.backendUrl)) return;
  engineStarting = true;
  try {
    try {
      const response = await fetch("http://127.0.0.1:4570/api/v1/health", {signal: AbortSignal.timeout(1800)});
      if (response.ok) return;
    } catch { /* Start the managed engine when the local service is absent. */ }
    const backend = app.isPackaged ? path.join(process.resourcesPath, "backend") : path.resolve(__dirname, "../../../backend");
    const entry = path.join(backend, "dist/index.js");
    await fs.access(entry);
    const executable = app.isPackaged ? path.join(backend, "node.exe") : "node";
    const log = createWriteStream(path.join(app.getPath("userData"), "local-engine.log"), {flags: "a"});
    localEngine = spawn(executable, [entry], {cwd: backend, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {...process.env, PORT: "4570"}});
    localEngine.stdout?.pipe(log, {end: false});
    localEngine.stderr?.pipe(log, {end: false});
    localEngine.once("error", () => {localEngine = null; log.end();});
    localEngine.once("exit", () => {localEngine = null; log.end();});
  } catch (error) { console.error("Local engine could not start:", error); }
  finally { engineStarting = false; }
}

app.on("before-quit", () => {
  quitting = true;
  if (engineTimer) clearInterval(engineTimer);
  localEngine?.kill();
  browserManager?.dispose();
});

const MAX_RECENTS = 8;

function defaultWorkspacePath(): string {
  return path.join(app.getPath("userData"), "workspace");
}

function recentsPath(): string {
  return path.join(app.getPath("userData"), "orvyn-recents.json");
}

async function ensureDefaultWorkspace(): Promise<string> {
  const root = defaultWorkspacePath();
  await fs.mkdir(root, { recursive: true });
  const readme = path.join(root, "README.md");
  try {
    await fs.access(readme);
  } catch {
    await fs.writeFile(
      readme,
      [
        "# ORVYN workspace",
        "",
        "This is your default ORVYN workspace. You can chat, run Agent, and create files here",
        "without opening a project folder. Use **Open Folder** when you want to work inside",
        "an existing codebase.",
        "",
      ].join("\n"),
      "utf-8"
    );
  }
  return root;
}

function activeRoot(): string {
  return currentProjectRoot ?? defaultWorkspacePath();
}

async function loadRecents(): Promise<string[]> {
  try {
    const raw = await fs.readFile(recentsPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

async function pushRecent(folder: string): Promise<string[]> {
  const recents = (await loadRecents()).filter((p) => path.resolve(p) !== path.resolve(folder));
  recents.unshift(folder);
  const next = recents.slice(0, MAX_RECENTS);
  await fs.writeFile(recentsPath(), JSON.stringify(next, null, 2), "utf-8");
  return next;
}

function appIconPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "icon.ico");
  }
  return path.join(__dirname, "../../resources/icon.ico");
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: "#0b0e14",
    title: "ORVYN",
    icon: appIconPath(),
    frame: false,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 12, y: 12 },
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on("maximize", () => mainWindow?.webContents.send("window:maximized", true));
  mainWindow.on("unmaximize", () => mainWindow?.webContents.send("window:maximized", false));

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

// Single instance: relaunching (e.g. the desktop shortcut while ORVYN is
// already open) focuses the existing window instead of opening a second app.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(async () => {
    await ensureDefaultWorkspace();
    const recent = (await loadRecents())[0];
    if (recent) { try { if ((await fs.stat(recent)).isDirectory()) currentProjectRoot = recent; } catch { /* missing folder falls back to workspace */ } }
    await ensureLocalEngine();
    engineTimer = setInterval(() => void ensureLocalEngine(), 15000);
    createWindow();
    browserManager = createWorkbenchBrowserManager(() => mainWindow);
    await browserManager.start();
    if (mainWindow) browserManager.bindWindow(mainWindow);
    await registerBrowserIpc(browserManager);
    void registerElectronBrowserTarget(browserManager);
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function resolveInProject(relativePath: string): string {
  const root = activeRoot();
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(path.resolve(root))) {
    throw new Error("Path escapes project root — refused");
  }
  return resolved;
}

ipcMain.handle("project:getWorkspace", async () => {
  const defaultRoot = await ensureDefaultWorkspace();
  const root = currentProjectRoot ?? defaultRoot;
  return {
    root,
    kind: currentProjectRoot ? "folder" : "default",
    recents: await loadRecents(),
  };
});

ipcMain.handle("project:open", async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  if (result.canceled || result.filePaths.length === 0) return null;
  currentProjectRoot = result.filePaths[0];
  const recents = await pushRecent(currentProjectRoot);
  return { root: currentProjectRoot, kind: "folder" as const, recents };
});

ipcMain.handle("project:openPath", async (_evt, folder: string) => {
  const resolved = path.resolve(folder);
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) throw new Error("Not a folder");
  } catch {
    return null;
  }
  currentProjectRoot = resolved;
  const recents = await pushRecent(resolved);
  return { root: currentProjectRoot, kind: "folder" as const, recents };
});

ipcMain.handle("project:openFile", async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openFile"] });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  currentProjectRoot = path.dirname(filePath);
  const recents = await pushRecent(currentProjectRoot);
  return {
    root: currentProjectRoot,
    kind: "folder" as const,
    recents,
    fileRelative: path.basename(filePath),
  };
});

ipcMain.handle("project:close", async () => {
  currentProjectRoot = null;
  const root = await ensureDefaultWorkspace();
  return { root, kind: "default" as const, recents: await loadRecents() };
});

ipcMain.handle("project:listDirectory", async (_evt, relativePath: string) => {
  const target = resolveInProject(relativePath || ".");
  const entries = await fs.readdir(target, { withFileTypes: true });
  const IGNORE = new Set(["node_modules", ".git", "dist", "build"]);
  return entries
    .filter((e) => !IGNORE.has(e.name))
    .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
});

ipcMain.handle("project:listFiles", async () => {
  const root = activeRoot();
  const IGNORE = new Set(["node_modules", ".git", "dist", "build", "coverage", ".orvyn"]);
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (results.length >= 8000) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORE.has(entry.name) || entry.name.startsWith(".env")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else results.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }

  await walk(root);
  return results;
});

ipcMain.handle("project:readFile", async (_evt, relativePath: string) => {
  const target = resolveInProject(relativePath);
  return fs.readFile(target, "utf-8");
});

ipcMain.handle("project:writeFile", async (_evt, relativePath: string, content: string) => {
  const target = resolveInProject(relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf-8");
  return true;
});

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const MAX_ATTACH_BYTES = 4_000_000;

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

async function readAttachment(filePath: string): Promise<{
  path: string;
  kind: "text" | "image";
  content?: string;
  mime?: string;
  dataUrl?: string;
} | null> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > MAX_ATTACH_BYTES) return null;
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);
  if (IMAGE_EXTS.has(ext)) {
    const buf = await fs.readFile(filePath);
    const mime = mimeFor(filePath);
    return { path: name, kind: "image", mime, dataUrl: `data:${mime};base64,${buf.toString("base64")}` };
  }
  const content = await fs.readFile(filePath, "utf-8");
  if (content.includes("\u0000")) return null;
  return { path: name, kind: "text", content: content.slice(0, 12_000) };
}

ipcMain.handle("attachments:pickFolder", async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  if (result.canceled || result.filePaths.length === 0) return null;
  const folder = result.filePaths[0];
  const root = currentProjectRoot;
  if (root) {
    const rel = path.relative(root, folder);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      return { error: "Folder must be inside the open workspace." };
    }
    return { path: rel.split(path.sep).join("/"), name: path.basename(folder) };
  }
  return { error: "Open a workspace to add folders as context." };
});

ipcMain.handle("attachments:pick", async () => {
  if (!mainWindow) return [];
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Files", extensions: ["*"] },
      { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] },
    ],
  });
  if (result.canceled) return [];
  const out = [];
  for (const filePath of result.filePaths.slice(0, 8)) {
    try {
      const att = await readAttachment(filePath);
      if (att) out.push({ ...att, sourcePath: filePath });
    } catch {
      // Skip unreadable files.
    }
  }
  return out;
});

ipcMain.handle("project:readBinary", async (_evt, relativePath: string) => {
  const target = resolveInProject(relativePath);
  const att = await readAttachment(target);
  if (!att) return null;
  return { ...att, path: relativePath.split(/[\\/]/).join("/") };
});

const CONFIG_PATH = path.join(app.getPath("userData"), "orvyn-connection.json");
const DEFAULT_CONFIG = { backendUrl: "http://localhost:4570", apiKey: "" };

interface PersistedConfig {
  backendUrl?: string;
  apiKey?: string;
  /** OS-keychain ciphertext for orvsess_ tokens. Never the raw token. */
  sessionTokenEnc?: string;
}

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function decryptSession(enc: string): string {
  if (!encryptionAvailable()) return "";
  try {
    return safeStorage.decryptString(Buffer.from(enc, "base64"));
  } catch {
    return "";
  }
}

async function writeConfig(config: { backendUrl: string; apiKey: string }): Promise<{ backendUrl: string; apiKey: string }> {
  // Session tokens go through the OS credential store (Electron safeStorage).
  // If the keychain is unavailable the token is kept in memory only.
  // Developer API keys stay in the config file at mode 0600.
  const stored = connectionFileRecord(config, (token) => {
    if (!encryptionAvailable()) return null;
    return safeStorage.encryptString(token).toString("base64");
  });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(stored, null, 2), { mode: 0o600 });
  return { backendUrl: config.backendUrl, apiKey: config.apiKey };
}

async function readConfig(): Promise<typeof DEFAULT_CONFIG> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as PersistedConfig;
    const backendUrl = parsed.backendUrl || DEFAULT_CONFIG.backendUrl;
    if (parsed.sessionTokenEnc) {
      return { backendUrl, apiKey: decryptSession(parsed.sessionTokenEnc) };
    }
    const apiKey = typeof parsed.apiKey === "string" ? parsed.apiKey : "";
    if (apiKey.startsWith("orvsess_")) {
      return writeConfig({ backendUrl, apiKey });
    }
    return { backendUrl, apiKey };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

ipcMain.handle(WINDOW_IPC.minimize, () => handleWindowAction(mainWindow, "minimize"));
ipcMain.handle(WINDOW_IPC.toggleMaximize, () => handleWindowAction(mainWindow, "toggleMaximize"));
ipcMain.handle(WINDOW_IPC.toggleMaximizeAlias, () => handleWindowAction(mainWindow, "toggleMaximize"));
ipcMain.handle(WINDOW_IPC.close, () => handleWindowAction(mainWindow, "close"));
ipcMain.handle(WINDOW_IPC.isMaximized, () => handleWindowAction(mainWindow, "isMaximized"));
ipcMain.handle(WINDOW_IPC.getState, () => handleWindowAction(mainWindow, "getState"));
ipcMain.handle(WINDOW_IPC.saveText, async (_evt, payload: unknown) => {
  const valid = validateSaveTextPayload(payload);
  if (!valid || !mainWindow) return { ok: false };
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: valid.defaultName,
    filters: [
      { name: "Markdown", extensions: ["md"] },
      { name: "JSON", extensions: ["json"] },
      { name: "Text", extensions: ["txt"] },
    ],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  await fs.writeFile(result.filePath, valid.content, "utf-8");
  return { ok: true, path: result.filePath };
});
ipcMain.handle(WINDOW_IPC.clipboardWrite, (_evt, text: unknown) => {
  const valid = validateClipboardText(text);
  if (valid == null) return false;
  clipboard.writeText(valid);
  return true;
});
ipcMain.handle(WINDOW_IPC.openExternal, async (_evt, url: unknown) => {
  const valid = validateExternalUrl(url);
  if (!valid) return false;
  await shell.openExternal(valid);
  return true;
});

ipcMain.handle("window:toggleDevTools", () => {
  mainWindow?.webContents.toggleDevTools();
});

ipcMain.handle("window:reload", () => {
  mainWindow?.webContents.reload();
});

// Chat history lives in userData, not the project: chats follow the user
// across folders, and a repo should never accidentally contain conversations.
const CHATS_PATH = path.join(app.getPath("userData"), "orvyn-chats.json");

ipcMain.handle("chats:load", async () => {
  try {
    return JSON.parse(await fs.readFile(CHATS_PATH, "utf-8"));
  } catch {
    return { sessions: [] };
  }
});

ipcMain.handle("chats:save", async (_evt, data: unknown) => {
  await fs.writeFile(CHATS_PATH, JSON.stringify(data), "utf-8");
  return true;
});

ipcMain.handle("config:get", () => readConfig());
ipcMain.handle("marketplace:officialSearch", (_evt, query: unknown, limit: unknown) =>
  fetchOfficialRegistry(typeof query === "string" ? query : "", typeof limit === "number" ? limit : 24)
);

// ── Real terminal: PowerShell through child_process pipes ────────────────
// node-pty (full interactive TUI) remains the upgrade path; pipes give a
// REAL shell today — real input, real streamed output, no simulation.
// The renderer only ever talks to these three validated channels.
const shells = new Map<string, { proc: ReturnType<typeof import("child_process").spawn>; buffer: string[] }>();

function pushShellEvent(sessionId: string, data: string) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("terminal:data", { sessionId, data });
  }
}

ipcMain.handle("terminal:start", async () => {
  const sessionId = `term_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const { spawn } = await import("child_process");
  // Project the user's real shell: PowerShell 7 when present, Windows
  // PowerShell otherwise (pwsh isn't guaranteed on Windows hosts).
  const shell = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "bash";
  const cwd = (globalThis as { __orvynWorkspaceRoot?: string }).__orvynWorkspaceRoot || os.homedir();
  const proc = spawn(shell, process.platform === "win32" ? ["-NoLogo", "-NoExit", "-Command", "-"] : ["-i"], {
    cwd,
    env: { ...process.env, TERM: "dumb", NO_COLOR: "1" },
    windowsHide: true,
  });
  shells.set(sessionId, { proc, buffer: [] });
  pushShellEvent(sessionId, `\r\nORVYN terminal — ${shell} (${cwd})\r\n\r\n`);
  proc.stdout?.on("data", (d) => pushShellEvent(sessionId, d.toString()));
  proc.stderr?.on("data", (d) => pushShellEvent(sessionId, d.toString()));
  proc.on("exit", (code) => {
    pushShellEvent(sessionId, `\r\n\u001b[90mshell exited (${code})\u001b[0m\r\n`);
    shells.delete(sessionId);
  });
  return sessionId;
});

ipcMain.handle("terminal:write", (_evt, sessionId: string, input: string) => {
  const s = shells.get(sessionId);
  if (!s) return false;
  s.proc.stdin?.write(input);
  return true;
});

ipcMain.handle("terminal:kill", (_evt, sessionId: string) => {
  const s = shells.get(sessionId);
  if (!s) return false;
  s.proc.kill();
  shells.delete(sessionId);
  return true;
});

// Live machine stats for the status bar. Real samples only: CPU from a
// two-point idle-delta across cores (loadavg is always 0 on Windows), RAM
// from os memory, disk from statfs on the system drive.
ipcMain.handle("system:getStats", async () => {
  try {
    const sample = () => {
      let idle = 0;
      let total = 0;
      for (const c of os.cpus()) {
        idle += c.times.idle;
        total += c.times.idle + c.times.user + c.times.nice + c.times.sys + c.times.irq;
      }
      return { idle, total };
    };
    const a = sample();
    await new Promise((r) => setTimeout(r, 250));
    const b = sample();
    const cpuPercent = b.total > a.total ? Math.round((1 - (b.idle - a.idle) / (b.total - a.total)) * 100) : 0;
    const ramPercent = Math.round((1 - os.freemem() / os.totalmem()) * 100);

    let diskPercent = 0;
    try {
      const statfs = (fs as unknown as {
        statfs?: (p: string) => Promise<{ bavail: number; blocks: number }>;
      }).statfs;
      if (statfs) {
        const st = await statfs(os.platform() === "win32" ? "C:\\" : "/");
        diskPercent = Math.round((1 - st.bavail / st.blocks) * 100);
      }
    } catch {
      // statfs unavailable — RAM only.
    }
    return {
      cpuPercent: Math.min(100, Math.max(0, cpuPercent)),
      ramPercent,
      diskPercent,
    };
  } catch {
    return { cpuPercent: 0, ramPercent: 0, diskPercent: 0 };
  }
});

ipcMain.handle("config:set", async (_evt, config: { backendUrl: string; apiKey: string }) => {
  return writeConfig({
    backendUrl: String(config?.backendUrl ?? DEFAULT_CONFIG.backendUrl),
    apiKey: String(config?.apiKey ?? ""),
  });
});

async function registerElectronBrowserTarget(manager: WorkbenchBrowserManager): Promise<void> {
  const info = manager.loopbackInfo();
  const config = await readConfig();
  if (!info || !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/i.test(config.backendUrl)) return;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  await fetch(`${config.backendUrl.replace(/\/$/, "")}/api/v1/desktop/browser-target`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url: info.url, token: info.token }),
  }).catch(() => {});
}

ipcMain.handle("system:getIdentity", () => {
  const username = os.userInfo().username?.trim() ?? "";
  const name = username ? username.charAt(0).toUpperCase() + username.slice(1) : "";
  return { name };
});
