// Browser-only fallback so the Vite preview can render without Electron.
// Real window/PTY/file APIs stay in preload; this never ships as Electron IPC.

import type { OrvynBridge } from "./orvyn-bridge";

export function installPreviewBridge(): void {
  if (typeof window === "undefined" || window.orvyn) return;
  const noop = async () => undefined;
  window.orvyn = {
    system: {
      getStats: async () => ({ cpuPercent: 0, ramPercent: 0, diskPercent: 0 }),
      getIdentity: async () => ({ name: "preview" }),
    },
    terminal: {
      start: async () => "preview",
      write: async () => false,
      kill: async () => false,
      onData: () => () => undefined,
    },
    project: {
      getWorkspace: async () => ({ root: "", kind: "default", recents: [] }),
      open: async () => null,
      openPath: async () => null,
      openFile: async () => null,
      close: async () => ({ root: "", kind: "default", recents: [] }),
      listDirectory: async () => [],
      listFiles: async () => [],
      readFile: async () => "",
      writeFile: async () => false,
      readBinary: async () => null,
    },
    attachments: {
      pick: async () => [],
      pickFolder: async () => null,
    },
    window: {
      minimize: noop,
      toggleMaximize: async () => false,
      close: noop,
      isMaximized: async () => false,
      getState: async () => ({ maximized: false }),
      saveText: async () => ({ ok: false }),
      writeClipboard: async (text) => {
        await navigator.clipboard.writeText(text);
        return true;
      },
      toggleDevTools: noop,
      reload: async () => window.location.reload(),
      onMaximizedChange: () => () => undefined,
    },
    chats: {
      load: async () => ({ sessions: [] }),
      save: async () => true,
    },
    config: {
      get: async () => ({ backendUrl: "http://localhost:4570", apiKey: "" }),
      set: async (config) => config,
    },
  } satisfies OrvynBridge;
}
