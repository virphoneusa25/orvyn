// apps/desktop/src/main/windowIpc.ts
//
// Explicit, validated window-control IPC. The renderer never sees ipcRenderer;
// preload maps these channels onto window.orvyn.window.*.

export const WINDOW_IPC = {
  minimize: "window:minimize",
  toggleMaximize: "window:toggleMaximize",
  toggleMaximizeAlias: "window:toggle-maximize",
  close: "window:close",
  isMaximized: "window:isMaximized",
  getState: "window:get-state",
  maximizedPush: "window:maximized",
  saveText: "window:save-text",
  clipboardWrite: "clipboard:write",
  openExternal: "window:open-external",
} as const;

export type WindowAction = "minimize" | "toggleMaximize" | "close" | "getState" | "isMaximized";

export interface ElectronWindowLike {
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  close(): void;
  isMaximized(): boolean;
}

export interface WindowState {
  maximized: boolean;
}

export function handleWindowAction(win: ElectronWindowLike | null, action: WindowAction): WindowState | boolean | void {
  if (action === "getState") return { maximized: win?.isMaximized() ?? false };
  if (action === "isMaximized") return win?.isMaximized() ?? false;
  if (!win) return action === "toggleMaximize" ? false : undefined;
  if (action === "minimize") {
    win.minimize();
    return;
  }
  if (action === "close") {
    win.close();
    return;
  }
  if (action === "toggleMaximize") {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  }
}

export function maximizeIconLabel(maximized: boolean): "Restore" | "Maximize" {
  return maximized ? "Restore" : "Maximize";
}

export function validateSaveTextPayload(payload: unknown): { defaultName: string; content: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const rec = payload as { defaultName?: unknown; content?: unknown };
  if (typeof rec.content !== "string") return null;
  if (rec.content.length > 2_000_000) return null;
  const rawName = typeof rec.defaultName === "string" && rec.defaultName.trim() ? rec.defaultName.trim() : "orvyn-transcript.md";
  const defaultName = rawName.replace(/[/\\]/g, "").replace(/\.\./g, "") || "orvyn-transcript.md";
  return { defaultName, content: rec.content };
}

export function validateClipboardText(text: unknown): string | null {
  if (typeof text !== "string") return null;
  if (text.length > 2_000_000) return null;
  return text;
}

/** Only http(s) URLs may leave the app. javascript: / file: / data: are rejected. */
export function validateExternalUrl(url: unknown): string | null {
  if (typeof url !== "string" || url.length > 2048) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}
