// apps/desktop/src/main/main.ts
import { app, BrowserWindow, ipcMain, dialog } from "electron";
import * as path from "path";
import { promises as fs } from "fs";

let mainWindow: BrowserWindow | null = null;
let currentProjectRoot: string | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: "#0b0e14",
    webPreferences: {
      // Security: no direct Node access in the renderer. All privileged
      // operations (file system, dialogs) go through the preload bridge.
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

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// --- Secure IPC surface. Renderer never touches `fs` or `child_process`
// directly — every operation is validated here against currentProjectRoot. ---

function resolveInProject(relativePath: string): string {
  if (!currentProjectRoot) throw new Error("No project is open");
  const resolved = path.resolve(currentProjectRoot, relativePath);
  if (!resolved.startsWith(path.resolve(currentProjectRoot))) {
    throw new Error("Path escapes project root — refused");
  }
  return resolved;
}

ipcMain.handle("project:open", async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  if (result.canceled || result.filePaths.length === 0) return null;
  currentProjectRoot = result.filePaths[0];
  return currentProjectRoot;
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

// --- Connection settings (backend URL + API key), persisted to disk so the
// desktop client can point at a cloud-deployed backend instead of localhost. ---
const CONFIG_PATH = path.join(app.getPath("userData"), "viride-connection.json");
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
