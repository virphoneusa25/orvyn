// apps/desktop/src/preload/preload.ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("orvyn", {
  system: {
    /** Live machine stats for the status bar — sampled in main, never guessed. */
    getStats: (): Promise<{ cpuPercent: number; ramPercent: number; diskPercent: number }> =>
      ipcRenderer.invoke("system:getStats"),
    getIdentity: (): Promise<{ name: string }> => ipcRenderer.invoke("system:getIdentity"),
  },
  terminal: {
    start: (): Promise<string> => ipcRenderer.invoke("terminal:start"),
    write: (sessionId: string, input: string): Promise<boolean> =>
      ipcRenderer.invoke("terminal:write", sessionId, input),
    kill: (sessionId: string): Promise<boolean> => ipcRenderer.invoke("terminal:kill", sessionId),
    onData: (cb: (e: { sessionId: string; data: string }) => void) => {
      const h = (_e: unknown, v: { sessionId: string; data: string }) => cb(v);
      ipcRenderer.on("terminal:data", h);
      return () => ipcRenderer.removeListener("terminal:data", h);
    },
  },
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
    pickFolder: () => ipcRenderer.invoke("attachments:pickFolder"),
  },
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke("window:toggleMaximize"),
    close: () => ipcRenderer.invoke("window:close"),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:isMaximized"),
    getState: (): Promise<{ maximized: boolean }> => ipcRenderer.invoke("window:get-state"),
    saveText: (payload: { defaultName?: string; content: string }) => ipcRenderer.invoke("window:save-text", payload),
    writeClipboard: (text: string) => ipcRenderer.invoke("clipboard:write", text),
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
