// One Workbench. Legacy inspector* keys cannot remount a second column.

import { isAgentWorkspaceTab, type AgentWorkspaceTab } from "./agentWorkspaceModel.ts";
import { parseWorkbenchTab } from "./workbenchModel.ts";

export const DESKTOP_LAYOUT_KEY = "orvyn:desktop-layout";

export const TERMINAL_MIN_HEIGHT = 140;
export const TERMINAL_MAX_HEIGHT = 520;
export const TERMINAL_DEFAULT_HEIGHT = 280;

export const AGENT_PANEL_MIN = 420;
export const AGENT_PANEL_DEFAULT = 650;
export const CHAT_MIN = 500;
export const SIDEBAR_WIDTH = 248;

export interface AgentWorkspaceLayout {
  open: boolean;
  width: number;
  activeTab: AgentWorkspaceTab;
  followOrion: boolean;
}

export interface DesktopLayoutState {
  rightPanelOpen: boolean;
  bottomTerminalOpen: boolean;
  bottomTerminalHeight: number;
  helpOpen: boolean;
  agentPanelWidth: number;
  activeTab: AgentWorkspaceTab;
  activeTabId: string;
  openTabIds: string[];
  previewUrl: string;
  browserUrl: string;
  recentUrls: string[];
  followOrion: boolean;
  expandedPreview: boolean;
}

export const DEFAULT_DESKTOP_LAYOUT: DesktopLayoutState = {
  rightPanelOpen: false,
  bottomTerminalOpen: false,
  bottomTerminalHeight: TERMINAL_DEFAULT_HEIGHT,
  helpOpen: false,
  agentPanelWidth: AGENT_PANEL_DEFAULT,
  activeTab: "changes",
  activeTabId: "changes",
  openTabIds: ["changes", "browser"],
  previewUrl: "",
  browserUrl: "",
  recentUrls: [],
  followOrion: true,
  expandedPreview: false,
};

export function clampTerminalHeight(height: number, viewportHeight = 900): number {
  const max = Math.min(TERMINAL_MAX_HEIGHT, Math.max(TERMINAL_MIN_HEIGHT, Math.floor(viewportHeight * 0.45)));
  if (!Number.isFinite(height)) return TERMINAL_DEFAULT_HEIGHT;
  return Math.max(TERMINAL_MIN_HEIGHT, Math.min(max, Math.round(height)));
}

export function clampAgentPanelWidth(width: number, viewportWidth = 1440): number {
  if (!Number.isFinite(width)) return AGENT_PANEL_DEFAULT;
  const maxByVw = Math.floor(viewportWidth * 0.75);
  const room = Math.max(AGENT_PANEL_MIN, viewportWidth - SIDEBAR_WIDTH - CHAT_MIN - 8);
  const max = Math.max(AGENT_PANEL_MIN, Math.min(maxByVw, room));
  return Math.max(AGENT_PANEL_MIN, Math.min(Math.round(width), max));
}

/**
 * The Workbench used to ABSOLUTE-overlay the center column on narrow
 * windows, which hid the chat composer entirely (no prompt box, no queue,
 * no steering). That regression is why this now always returns false: the
 * right panel docks or hides, it never covers the conversation.
 */
export function shouldOverlayAgentPanel(_viewportWidth: number): boolean {
  return false;
}

/** True when the viewport has room for sidebar + chat + docked Workbench.
 *  When false the Workbench hides (one click to reopen) — the chat with its
 *  composer ALWAYS stays visible and usable. */
export function fitsDockedWorkbench(viewportWidth: number): boolean {
  return viewportWidth >= SIDEBAR_WIDTH + CHAT_MIN + AGENT_PANEL_MIN;
}

function safeUrl(value: unknown): string {
  return typeof value === "string" && value.startsWith("http") && value.length < 2000 ? value : "";
}

function safeTabId(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 && value.length < 400 ? value : fallback;
}

function safeTabIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_DESKTOP_LAYOUT.openTabIds];
  const ids = value.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length < 400).slice(0, 24);
  return ids.includes("changes") ? ids : ["changes", ...ids];
}

function migrateActiveTab(rec: Record<string, unknown>): AgentWorkspaceTab {
  if (isAgentWorkspaceTab(rec.activeTab)) return rec.activeTab;
  const id = typeof rec.activeTabId === "string" ? rec.activeTabId : "";
  if (id) {
    const parsed = parseWorkbenchTab(id);
    if (isAgentWorkspaceTab(parsed.kind)) return parsed.kind;
  }
  const surface = typeof rec.surfaceTab === "string" ? rec.surfaceTab : "";
  if (surface.startsWith("preview")) return "preview";
  if (isAgentWorkspaceTab(surface)) return surface;
  return "changes";
}

function migrateWidth(rec: Record<string, unknown>): number {
  if (Number.isFinite(Number(rec.agentPanelWidth))) return clampAgentPanelWidth(Number(rec.agentPanelWidth));
  if (Number.isFinite(Number(rec.workSurfaceWidth))) return clampAgentPanelWidth(Number(rec.workSurfaceWidth));
  return AGENT_PANEL_DEFAULT;
}

export function parseDesktopLayout(raw: unknown): DesktopLayoutState {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_DESKTOP_LAYOUT };
  const rec = raw as Record<string, unknown>;
  const activeTab = migrateActiveTab(rec);
  const activeTabId = safeTabId(rec.activeTabId ?? rec.activeTab, activeTab);
  return {
    rightPanelOpen: rec.rightPanelOpen === true,
    bottomTerminalOpen: rec.bottomTerminalOpen === true,
    bottomTerminalHeight: clampTerminalHeight(Number(rec.bottomTerminalHeight ?? TERMINAL_DEFAULT_HEIGHT)),
    helpOpen: rec.helpOpen === true,
    agentPanelWidth: migrateWidth(rec),
    activeTab,
    activeTabId,
    openTabIds: safeTabIds(rec.openTabIds),
    previewUrl: safeUrl(rec.previewUrl),
    browserUrl: safeUrl(rec.browserUrl),
    recentUrls: Array.isArray(rec.recentUrls) ? rec.recentUrls.map(safeUrl).filter(Boolean).slice(0, 8) : [],
    followOrion: rec.followOrion !== false,
    expandedPreview: rec.expandedPreview === true,
  };
}

export function persistableLayout(state: DesktopLayoutState): Omit<DesktopLayoutState, "helpOpen"> {
  return {
    rightPanelOpen: state.rightPanelOpen,
    bottomTerminalOpen: state.bottomTerminalOpen,
    bottomTerminalHeight: clampTerminalHeight(state.bottomTerminalHeight),
    agentPanelWidth: clampAgentPanelWidth(state.agentPanelWidth, 2400),
    activeTab: isAgentWorkspaceTab(state.activeTab) ? state.activeTab : "changes",
    activeTabId: safeTabId(state.activeTabId, "changes"),
    openTabIds: safeTabIds(state.openTabIds),
    previewUrl: safeUrl(state.previewUrl),
    browserUrl: safeUrl(state.browserUrl),
    recentUrls: state.recentUrls.map(safeUrl).filter(Boolean).slice(0, 8),
    followOrion: state.followOrion,
    expandedPreview: state.expandedPreview,
  };
}

export function toAgentWorkspaceLayout(state: DesktopLayoutState): AgentWorkspaceLayout {
  return {
    open: state.rightPanelOpen,
    width: state.agentPanelWidth,
    activeTab: state.activeTab,
    followOrion: state.followOrion,
  };
}

type Listener = (state: DesktopLayoutState) => void;

let state: DesktopLayoutState = { ...DEFAULT_DESKTOP_LAYOUT };
const listeners = new Set<Listener>();
let loaded = false;

function emit(): void {
  listeners.forEach((l) => l(state));
}

function readStorage(): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(DESKTOP_LAYOUT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStorage(next: DesktopLayoutState): void {
  try {
    globalThis.localStorage?.setItem(DESKTOP_LAYOUT_KEY, JSON.stringify(persistableLayout(next)));
  } catch {
    /* private mode */
  }
}

export function loadDesktopLayout(): DesktopLayoutState {
  if (!loaded) {
    state = parseDesktopLayout(readStorage());
    loaded = true;
  }
  return state;
}

export function getDesktopLayout(): DesktopLayoutState {
  return loadDesktopLayout();
}

export function setDesktopLayout(patch: Partial<DesktopLayoutState>): DesktopLayoutState {
  const current = loadDesktopLayout();
  const nextTab = patch.activeTab ?? current.activeTab;
  const nextId = patch.activeTabId ?? current.activeTabId;
  state = {
    ...current,
    ...patch,
    bottomTerminalHeight: clampTerminalHeight(patch.bottomTerminalHeight ?? current.bottomTerminalHeight),
    agentPanelWidth: clampAgentPanelWidth(
      patch.agentPanelWidth ?? current.agentPanelWidth,
      typeof window !== "undefined" ? window.innerWidth : 1440
    ),
    activeTab: isAgentWorkspaceTab(nextTab) ? nextTab : "changes",
    activeTabId: safeTabId(nextId, "changes"),
    openTabIds: safeTabIds(patch.openTabIds ?? current.openTabIds),
    previewUrl: safeUrl(patch.previewUrl ?? current.previewUrl),
    browserUrl: safeUrl(patch.browserUrl ?? current.browserUrl),
    recentUrls: (patch.recentUrls ?? current.recentUrls).map(safeUrl).filter(Boolean).slice(0, 8),
  };
  writeStorage(state);
  emit();
  return state;
}

export function toggleRightPanel(): DesktopLayoutState {
  return setDesktopLayout({ rightPanelOpen: !loadDesktopLayout().rightPanelOpen });
}

export function toggleBottomTerminal(): DesktopLayoutState {
  return setDesktopLayout({ bottomTerminalOpen: !loadDesktopLayout().bottomTerminalOpen });
}

export function toggleHelp(): DesktopLayoutState {
  return setDesktopLayout({ helpOpen: !loadDesktopLayout().helpOpen });
}

export function subscribeDesktopLayout(listener: Listener): () => void {
  loadDesktopLayout();
  listeners.add(listener);
  return () => listeners.delete(listener);
}
