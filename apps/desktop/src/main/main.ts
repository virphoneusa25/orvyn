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
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  await ensureDefaultWorkspace();
  createWindow();
});

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

ipcMain.handle("config:get", () => readConfig());

ipcMain.handle("config:set", async (_evt, config: { backendUrl: string; apiKey: string }) => {
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  return config;
});
