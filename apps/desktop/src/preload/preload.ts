// apps/desktop/src/preload/preload.ts
import { contextBridge, ipcRenderer } from "electron";

// Minimal, explicit surface exposed to the renderer. No raw ipcRenderer,
// no Node globals — just the specific project operations the UI needs.
contextBridge.exposeInMainWorld("viride", {
  project: {
    open: (): Promise<string | null> => ipcRenderer.invoke("project:open"),
    listDirectory: (relativePath: string) =>
      ipcRenderer.invoke("project:listDirectory", relativePath),
    readFile: (relativePath: string): Promise<string> =>
      ipcRenderer.invoke("project:readFile", relativePath),
    writeFile: (relativePath: string, content: string): Promise<boolean> =>
      ipcRenderer.invoke("project:writeFile", relativePath, content),
  },
  config: {
    get: (): Promise<{ backendUrl: string; apiKey: string }> => ipcRenderer.invoke("config:get"),
    set: (config: { backendUrl: string; apiKey: string }): Promise<{ backendUrl: string; apiKey: string }> =>
      ipcRenderer.invoke("config:set", config),
  },
});
