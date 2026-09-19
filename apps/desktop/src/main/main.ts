// apps/desktop/src/main/main.ts
import { app, BrowserWindow, ipcMain, dialog } from "electron";
import * as path from "path";
import { promises as fs } from "fs";

let mainWindow: BrowserWindow | null = null;
let currentProjectRoot: string | null = null;

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
    createWindow();
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

async function readConfig(): Promise<typeof DEFAULT_CONFIG> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

ipcMain.handle("window:minimize", () => {
  mainWindow?.minimize();
});

ipcMain.handle("window:toggleMaximize", () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});

ipcMain.handle("window:close", () => {
  mainWindow?.close();
});

ipcMain.handle("window:isMaximized", () => mainWindow?.isMaximized() ?? false);

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

ipcMain.handle("config:set", async (_evt, config: { backendUrl: string; apiKey: string }) => {
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  return config;
});
