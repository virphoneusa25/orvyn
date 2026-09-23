// Browser-only fallback so the Vite preview can render without Electron.
// Real window/PTY/file APIs stay in preload; this never ships as Electron IPC.

import type { OrvynBridge } from "./orvyn-bridge";

export function installPreviewBridge(): void {
  if (typeof window === "undefined" || window.orvyn) return;
  try {
    if (!globalThis.localStorage?.getItem("orvyn:desktop-layout")) {
      globalThis.localStorage.setItem(
        "orvyn:desktop-layout",
        JSON.stringify({
          rightPanelOpen: true,
          bottomTerminalOpen: false,
          bottomTerminalHeight: 280,
          agentPanelWidth: 650,
          activeTab: "changes",
          activeTabId: "changes",
          openTabIds: ["changes", "browser"],
          previewUrl: "",
          browserUrl: "",
          recentUrls: [],
          followOrion: true,
          expandedPreview: false,
        })
      );
    }
  } catch {
    /* private mode */
  }
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
      openExternal: async (url) => {
        window.open(url, "_blank", "noopener,noreferrer");
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
    marketplace: {
      officialSearch: async (query, limit = 24, cursor) => {
        const params = new URLSearchParams({ version: "latest", limit: String(limit) });
        if (query.trim()) params.set("search", query.trim());
        if (cursor) params.set("cursor", cursor);
        const res = await fetch(`https://registry.modelcontextprotocol.io/v0.1/servers?${params}`);
        const body = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, body, error: res.ok ? undefined : body?.error };
      },
    },
    browser: {
      list: async () => ({ tabs: [], recents: [], activeId: null }),
      create: async () => ({ tabs: [], recents: [], activeId: null }),
      navigate: async () => ({ tabs: [], recents: [], activeId: null }),
      back: async () => ({ tabs: [], recents: [], activeId: null }),
      forward: async () => ({ tabs: [], recents: [], activeId: null }),
      reload: async () => ({ tabs: [], recents: [], activeId: null }),
      activate: async () => ({ tabs: [], recents: [], activeId: null }),
      close: async () => ({ tabs: [], recents: [], activeId: null }),
      setBounds: async () => ({ tabs: [], recents: [], activeId: null }),
      setVisible: async () => ({ tabs: [], recents: [], activeId: null }),
      takeControl: async () => ({ tabs: [], recents: [], activeId: null }),
      returnControl: async () => ({ tabs: [], recents: [], activeId: null }),
      openExternal: async () => false,
      clearData: async () => ({ tabs: [], recents: [], activeId: null }),
      openDevTools: async () => false,
      inspect: async () => ({ ok: false, error: "Embedded browser requires ORVYN Desktop" }),
      onChange: () => () => undefined,
    },
  } satisfies OrvynBridge;
}
