// apps/desktop/src/preload/preload.ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("orvyn", {
  project: {
    getWorkspace: () => ipcRenderer.invoke("project:getWorkspace"),
    open: () => ipcRenderer.invoke("project:open"),
    openPath: (folder: string) => ipcRenderer.invoke("project:openPath", folder),
    openFile: () => ipcRenderer.invoke("project:openFile"),
    close: () => ipcRenderer.invoke("project:close"),
    listDirectory: (relativePath: string) => ipcRenderer.invoke("project:listDirectory", relativePath),
    readFile: (relativePath: string): Promise<string> => ipcRenderer.invoke("project:readFile", relativePath),
    writeFile: (relativePath: string, content: string): Promise<boolean> =>
      ipcRenderer.invoke("project:writeFile", relativePath, content),
  },
  config: {
    get: (): Promise<{ backendUrl: string; apiKey: string }> => ipcRenderer.invoke("config:get"),
    set: (config: { backendUrl: string; apiKey: string }): Promise<{ backendUrl: string; apiKey: string }> =>
      ipcRenderer.invoke("config:set", config),
  },
});
