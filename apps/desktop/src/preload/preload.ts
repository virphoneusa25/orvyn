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
    listFiles: (): Promise<string[]> => ipcRenderer.invoke("project:listFiles"),
    readFile: (relativePath: string): Promise<string> => ipcRenderer.invoke("project:readFile", relativePath),
    writeFile: (relativePath: string, content: string): Promise<boolean> =>
      ipcRenderer.invoke("project:writeFile", relativePath, content),
    readBinary: (relativePath: string) => ipcRenderer.invoke("project:readBinary", relativePath),
  },
  attachments: {
    pick: () => ipcRenderer.invoke("attachments:pick"),
  },
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke("window:toggleMaximize"),
    close: () => ipcRenderer.invoke("window:close"),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:isMaximized"),
    toggleDevTools: () => ipcRenderer.invoke("window:toggleDevTools"),
    reload: () => ipcRenderer.invoke("window:reload"),
    onMaximizedChange: (cb: (v: boolean) => void) => {
      const h = (_e: unknown, v: boolean) => cb(v);
      ipcRenderer.on("window:maximized", h);
      return () => ipcRenderer.removeListener("window:maximized", h);
    },
  },
  chats: {
    load: () => ipcRenderer.invoke("chats:load"),
    save: (data: unknown) => ipcRenderer.invoke("chats:save", data),
  },
  config: {
    get: (): Promise<{ backendUrl: string; apiKey: string }> => ipcRenderer.invoke("config:get"),
    set: (config: { backendUrl: string; apiKey: string }): Promise<{ backendUrl: string; apiKey: string }> =>
      ipcRenderer.invoke("config:set", config),
  },
});
